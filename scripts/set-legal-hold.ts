import "dotenv/config";
import pg from "pg";
import { appendAuditEvent } from "../src/messages/audit.repository.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";
import {
  assertSafePostgresUrl,
  databaseTlsFromEnvironment
} from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL;
const requested = argument("active");
const reference = argument("reference");
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
if (!requested || !new Set(["true", "false"]).has(requested)) {
  throw new Error(
    "Usage: npm run db:set-legal-hold -- --active true|false --reference <approval-or-release-ticket>"
  );
}
if (!reference || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$/.test(reference)) {
  throw new Error("--reference must be a 3-100 character non-PII approval or release reference");
}

const active = requested === "true";
const execute = process.argv.includes("--confirm-legal-hold-change");
const retentionResumes = process.argv.includes("--confirm-retention-resumes");
const confirmedDatabase = argument("confirm-database");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseTlsFromEnvironment(process.env),
  max: 1
});
const client = await pool.connect();

try {
  const database = await client.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = database.rows[0]?.name;
  if (!databaseName || !/^[A-Za-z0-9_.-]{1,63}$/.test(databaseName)) {
    throw new Error("Connected database name is unavailable or unsafe");
  }
  const current = await client.query<{
    legal_hold_at: Date | null;
    legal_hold_reference: string | null;
    decommissioned_at: Date | null;
  }>(
    `SELECT legal_hold_at, legal_hold_reference, decommissioned_at
     FROM service_state WHERE singleton = TRUE`
  );
  const state = current.rows[0];
  if (!state) throw new Error("Service state is missing");
  if (state.decommissioned_at) throw new Error("A decommissioned service cannot change legal-hold state");

  if (!execute) {
    process.stdout.write(
      `Dry run for database ${databaseName}: legal hold is currently ` +
        `${state.legal_hold_at ? "active" : "inactive"}; requested state is ${active ? "active" : "inactive"}. ` +
        "No data was changed.\n"
    );
    process.stdout.write(
      `Re-run with --confirm-database ${databaseName} --confirm-legal-hold-change` +
        `${active ? "" : " --confirm-retention-resumes"}.\n`
    );
  } else {
    if (confirmedDatabase !== databaseName) {
      throw new Error("--confirm-database must exactly match the connected database name");
    }
    if (!active && !retentionResumes) {
      throw new Error("Releasing a hold requires --confirm-retention-resumes");
    }
    const security = loadAdminSecurityConfig();
    const encryption = new EnvelopeEncryption(security.encryption);
    const identifiers = new VersionedHmac(security.identifiers);
    const auditIntegrity = new VersionedHmac(security.auditIntegrity);
    await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
    await client.query("BEGIN");
    try {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('company-whatsapp-assistant'), hashtext('data-lifecycle')
         )`
      );
      const locked = await client.query<{ legal_hold_at: Date | null }>(
        `SELECT legal_hold_at FROM service_state WHERE singleton = TRUE FOR UPDATE`
      );
      if (!locked.rows[0]) throw new Error("Service state disappeared during legal-hold change");
      if (Boolean(locked.rows[0].legal_hold_at) === active) {
        throw new Error(`Legal hold is already ${active ? "active" : "inactive"}`);
      }
      await client.query(
        `UPDATE service_state
         SET legal_hold_at = CASE WHEN $1::boolean THEN NOW() ELSE NULL END,
             legal_hold_reference = CASE WHEN $1::boolean THEN $2 ELSE NULL END,
             updated_at = NOW()
         WHERE singleton = TRUE`,
        [active, reference]
      );
      await appendAuditEvent(client, auditIntegrity, {
        eventType: "privacy.legal_hold",
        outcome: "success",
        details: { active, approvalReference: reference }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      encryption.destroy();
      identifiers.destroy();
      auditIntegrity.destroy();
    }
    process.stdout.write(
      `Legal hold is now ${active ? "active" : "inactive"} for database ${databaseName}.\n`
    );
  }
} finally {
  client.release();
  await pool.end();
}
