import "dotenv/config";
import pg from "pg";
import type { CountryCode } from "libphonenumber-js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";
import { normalizeWhitelistUser, upsertWhitelistedUser } from "./whitelist-user.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
const security = loadAdminSecurityConfig();
const encryption = new EnvelopeEncryption(security.encryption);
const identifiers = new VersionedHmac(security.identifiers);
const auditIntegrity = new VersionedHmac(security.auditIntegrity);

const rawPhone = argument("phone");
const fullName = argument("name");
if (!rawPhone || !fullName) {
  throw new Error(
    'Usage: npm run db:add-user -- --phone "+905..." --name "Name" [--department "Sales"] [--role "employee"] [--locale "tr"] [--permissions "company.sales,..."]'
  );
}

const defaultCountry = (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as CountryCode;
const user = normalizeWhitelistUser(
  {
    phone: rawPhone,
    name: fullName,
    department: argument("department") ?? null,
    role: argument("role"),
    locale: argument("locale") ?? null,
    permissions: (argument("permissions") ?? "").split(",")
  },
  defaultCountry
);

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
  await client.query("BEGIN");
  const { created } = await upsertWhitelistedUser(client, { encryption, identifiers, auditIntegrity }, user);
  await client.query("COMMIT");
  process.stdout.write(`Whitelisted user is ${created ? "created" : "updated"} and ready.\n`);
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
