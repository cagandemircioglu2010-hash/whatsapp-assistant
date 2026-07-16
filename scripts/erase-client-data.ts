import "dotenv/config";
import pg from "pg";
import {
  eraseAssistantData,
  readClientDataCounts,
  type ClientDataCounts
} from "../src/security/data-lifecycle.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");

const execute = process.argv.includes("--confirm-erase-client-data");
const confirmedDatabase = argument("confirm-database");
const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
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
        `${before.audit_events} audit event(s). No data was changed.\n`
    );
    process.stdout.write(
      "After stopping the service, re-run with the displayed name in --confirm-database and " +
        "the --confirm-erase-client-data flag.\n"
    );
  } else {
    if (confirmedDatabase !== databaseName) {
      throw new Error("--confirm-database must exactly match the connected database name");
    }

    let erased: ClientDataCounts | null = null;
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '5min'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('company-whatsapp-assistant.data-lifecycle'))"
      );
      await client.query(
        "LOCK TABLE audit_events, messages, permissions, users IN ACCESS EXCLUSIVE MODE"
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
        `${erased.messages} message(s), and ${erased.audit_events} audit event(s).\n`
    );
    process.stdout.write(
      "Database rows are empty. Complete key, credential, log, backup, and provider-resource destruction separately.\n"
    );
  }
} finally {
  client.release();
  await pool.end();
}
