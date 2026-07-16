import "dotenv/config";
import pg from "pg";
import {
  eraseAssistantData,
  readClientDataCounts,
  type ClientDataCounts
} from "../src/security/data-lifecycle.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);

const execute = process.argv.includes("--confirm-erase-client-data");
const serviceStopped = process.argv.includes("--confirm-service-stopped");
const providerDisabled = process.argv.includes("--confirm-provider-webhook-disabled");
const confirmedDatabase = argument("confirm-database");
const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  const database = await client.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = database.rows[0]?.name;
  if (!databaseName) throw new Error("Current database name could not be determined");
  if (!/^[A-Za-z0-9_.-]{1,63}$/.test(databaseName)) {
    throw new Error("Connected database name contains characters unsafe for confirmation output");
  }

  if (!execute) {
    const before = await readClientDataCounts(client);
    process.stdout.write(
      `Dry run for database ${databaseName}: ${before.users} user(s), ` +
        `${before.permissions} permission(s), ${before.messages} message(s), ` +
        `${before.audit_events} audit event(s), ${before.rate_limit_buckets} rate-limit bucket(s), ` +
        `${before.encryption_canaries} encryption canary/canaries, and ` +
        `${before.audit_chain_anchors} audit anchor(s). No data was changed.\n`
    );
    process.stdout.write(
      "After stopping the service and disabling the Meta webhook, re-run with the displayed name, " +
        "--confirm-service-stopped, --confirm-provider-webhook-disabled, and --confirm-erase-client-data.\n"
    );
  } else {
    if (confirmedDatabase !== databaseName) {
      throw new Error("--confirm-database must exactly match the connected database name");
    }
    if (!serviceStopped || !providerDisabled) {
      throw new Error(
        "Client erasure requires --confirm-service-stopped and --confirm-provider-webhook-disabled"
      );
    }
    let erased: ClientDataCounts | null = null;
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '5min'");
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('company-whatsapp-assistant'), hashtext('data-lifecycle')
         )`
      );
      const hold = await client.query<{ active: boolean }>(
        `SELECT legal_hold_at IS NOT NULL AS active
         FROM service_state WHERE singleton = TRUE FOR UPDATE`
      );
      if (hold.rows[0]?.active) {
        throw new Error("Client erasure is blocked while an approved legal hold is active");
      }
      await client.query(
        `LOCK TABLE audit_events, messages, permissions, users, rate_limit_buckets,
                    encryption_canaries, audit_chain_anchors, audit_chain_state,
                    maintenance_job_state, service_state IN ACCESS EXCLUSIVE MODE`
      );
      await client.query(
        `UPDATE service_state
         SET decommissioned_at = NOW(), decommission_reason = 'client_data_erasure',
             legal_hold_at = NULL, legal_hold_reference = NULL, updated_at = NOW()
         WHERE singleton = TRUE`
      );
      erased = (await eraseAssistantData(client)).before;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    if (!erased) throw new Error("Client data erasure result was not recorded");
    process.stdout.write(
      `Erased ${erased.users} user(s), ${erased.permissions} permission(s), ` +
        `${erased.messages} message(s), ${erased.audit_events} audit event(s), ` +
        `${erased.rate_limit_buckets} rate-limit bucket(s), ${erased.encryption_canaries} canary/canaries, ` +
        `and ${erased.audit_chain_anchors} audit anchor(s).\n`
    );
    process.stdout.write(
      "Database rows are empty. Complete key, credential, log, backup, and provider-resource destruction separately.\n"
    );
  }
} finally {
  client.release();
  await pool.end();
}
