import "dotenv/config";
import pg from "pg";
import { normalizePhoneNumber } from "../src/security/phone.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { appendAuditEvent } from "../src/messages/audit.repository.js";
import { eraseUserData } from "../src/security/data-lifecycle.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";

const { Pool } = pg;
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databaseUrl = process.env.DATABASE_ADMIN_URL;
const rawPhone = argument("phone");
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
if (!rawPhone) {
  throw new Error(
    'Usage: npm run db:erase-user-data -- --phone "+905..." ' +
      "[--confirm-reference <reference> --confirm-service-stopped --confirm-erase-user-data]"
  );
}
const phone = normalizePhoneNumber(rawPhone, (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as "TR");
if (!phone) throw new Error("Phone number is not valid");

const security = loadAdminSecurityConfig();
const encryption = new EnvelopeEncryption(security.encryption);
const identifiers = new VersionedHmac(security.identifiers);
const auditIntegrity = new VersionedHmac(security.auditIntegrity);
const reference = identifiers.hash(phone, "erasure-reference").hash.slice(0, 16);
const execute = process.argv.includes("--confirm-erase-user-data");
const serviceStopped = process.argv.includes("--confirm-service-stopped");
const confirmedReference = argument("confirm-reference");

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseTlsFromEnvironment(process.env),
  max: 1
});
const client = await pool.connect();

try {
  await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
  const lookupHashes = identifiers
    .candidates(phone, "phone-identifier")
    .map((candidate) => candidate.hash);
  const found = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE phone_lookup_hash::text = ANY($1::text[]) LIMIT 1",
    [lookupHashes]
  );
  const userId = found.rows[0]?.id;
  if (!userId) throw new Error("Whitelist user was not found");
  const counts = await client.query<{ messages: number; permissions: number }>(
    `SELECT
       (SELECT COUNT(*)::integer FROM messages WHERE user_id = $1) AS messages,
       (SELECT COUNT(*)::integer FROM permissions WHERE user_id = $1) AS permissions`,
    [userId]
  );

  if (!execute) {
    process.stdout.write(
      `Dry run ${reference}: ${counts.rows[0]?.messages ?? 0} message(s) and ` +
        `${counts.rows[0]?.permissions ?? 0} permission(s) will be erased. No data was changed.\n`
    );
    process.stdout.write(
      `Stop every service/worker replica, then re-run with --confirm-reference ${reference} ` +
        "--confirm-service-stopped --confirm-erase-user-data after approval.\n"
    );
  } else {
    if (confirmedReference !== reference) {
      throw new Error("--confirm-reference must exactly match the dry-run reference");
    }
    if (!serviceStopped) {
      throw new Error("--confirm-service-stopped is required to prevent in-flight processing during erasure");
    }
    await client.query("BEGIN");
    try {
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
        throw new Error("User erasure is blocked while an approved legal hold is active");
      }
      const locked = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [userId]
      );
      if (!locked.rows[0]) throw new Error("Whitelist user disappeared before erasure");
      const result = await eraseUserData(client, userId);
      if (!result.userDeleted) throw new Error("Whitelist user was not deleted");
      const rateSubjects = [
        ...identifiers.candidates(userId, "rate-limit-user"),
        ...identifiers.candidates(phone, "rate-limit-subject")
      ].map((candidate) => candidate.hash);
      await client.query(
        "DELETE FROM rate_limit_buckets WHERE subject_hash::text = ANY($1::text[])",
        [rateSubjects]
      );
      await appendAuditEvent(client, auditIntegrity, {
        eventType: "identity.user_erasure",
        outcome: "success",
        details: {
          messagesDeleted: result.messagesDeleted,
          permissionsDeleted: result.permissionsDeleted
        }
      });
      await client.query("COMMIT");
      process.stdout.write(
        `Erased user ${reference}, ${result.messagesDeleted} message(s), and ` +
          `${result.permissionsDeleted} permission(s). Direct audit foreign-key links were removed.\n`
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
  encryption.destroy();
  identifiers.destroy();
  auditIntegrity.destroy();
}
