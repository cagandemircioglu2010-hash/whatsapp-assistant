import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { CountryCode } from "libphonenumber-js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";
import { normalizeWhitelistUser, upsertWhitelistedUser, type WhitelistUserInput } from "./whitelist-user.js";

const { Pool } = pg;

// Bulk onboarding for smoother whitelisting:
//
//   npm run db:whitelist-batch -- --file users.json
//
// users.json is an array of records:
//   [{ "phone": "+90...", "name": "Ada", "role": "employee",
//      "department": "Sales", "locale": "tr",
//      "permissions": ["company.sales"] }]
//
// Every row is validated up front; the whole batch is applied in one
// transaction so it is all-or-nothing — a single bad row aborts cleanly
// without leaving a half-onboarded set.

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argument("file");
if (!filePath) throw new Error('Usage: npm run db:whitelist-batch -- --file "users.json"');

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(filePath, "utf8"));
} catch (error) {
  throw new Error(`Could not read/parse ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`);
}
if (!Array.isArray(parsed)) throw new Error("The batch file must contain a JSON array of users");
if (parsed.length === 0) throw new Error("The batch file contains no users");
if (parsed.length > 500) throw new Error("Batch size is capped at 500 users per run");

const defaultCountry = (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as CountryCode;
// Validate every row before opening a transaction so a typo never leaves a
// partially applied batch, and the error names the offending row.
const users = parsed.map((entry, index) =>
  normalizeWhitelistUser(entry as WhitelistUserInput, defaultCountry, `row ${index + 1}`)
);

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
  let created = 0;
  let updated = 0;
  for (const user of users) {
    const result = await upsertWhitelistedUser(client, { encryption, identifiers, auditIntegrity }, user);
    if (result.created) created += 1;
    else updated += 1;
  }
  await client.query("COMMIT");
  process.stdout.write(`Batch complete: ${created} created, ${updated} updated (${users.length} total).\n`);
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
