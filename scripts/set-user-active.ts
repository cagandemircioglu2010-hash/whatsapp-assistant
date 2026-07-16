import "dotenv/config";
import pg from "pg";
import { normalizePhoneNumber } from "../src/security/phone.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { appendAuditEvent } from "../src/messages/audit.repository.js";
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
const requestedState = argument("active");
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
if (!rawPhone || !new Set(["true", "false"]).has(requestedState ?? "")) {
  throw new Error('Usage: npm run db:set-user-active -- --phone "+905..." --active true|false');
}
const phone = normalizePhoneNumber(rawPhone, (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as "TR");
if (!phone) throw new Error("Phone number is not valid");
const active = requestedState === "true";
const security = loadAdminSecurityConfig();
const encryption = new EnvelopeEncryption(security.encryption);
const identifiers = new VersionedHmac(security.identifiers);
const auditIntegrity = new VersionedHmac(security.auditIntegrity);

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();
try {
  await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
  await client.query("BEGIN");
  const updated = await client.query<{ id: string }>(
    `UPDATE users
     SET is_active = $2, updated_at = NOW()
     WHERE phone_lookup_hash::text = ANY($1::text[])
     RETURNING id`,
    [identifiers.candidates(phone, "phone-identifier").map((candidate) => candidate.hash), active]
  );
  const userId = updated.rows[0]?.id;
  if (!userId) throw new Error("Whitelist user was not found");
  await appendAuditEvent(client, auditIntegrity, {
    userId,
    eventType: "identity.activation_update",
    outcome: "success",
    details: { active }
  });
  await client.query("COMMIT");
  process.stdout.write(`User is now ${active ? "active" : "inactive"}.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
  encryption.destroy();
  identifiers.destroy();
  auditIntegrity.destroy();
}
