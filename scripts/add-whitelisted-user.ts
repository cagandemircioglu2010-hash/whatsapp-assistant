import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { normalizePhoneNumber } from "../src/security/phone.js";
import { reportResources } from "../src/auth/types.js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import { appendAuditEvent } from "../src/messages/audit.repository.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";

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
const department = argument("department") ?? null;
const role = argument("role") ?? "employee";
const locale = argument("locale") ?? null;
const requestedPermissions = (argument("permissions") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedResources = new Set<string>(Object.values(reportResources));
const allowedRoles = new Set(["employee", "manager", "executive", "admin"]);

if (!rawPhone || !fullName) {
  throw new Error(
    'Usage: npm run db:add-user -- --phone "+905..." --name "Name" [--department "Sales"] [--permissions "company.sales,..."]'
  );
}
const phone = normalizePhoneNumber(rawPhone, (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as "TR");
if (!phone) throw new Error("Phone number is not valid");
if (fullName.trim().length < 2 || fullName.trim().length > 120) throw new Error("Name must be 2-120 characters");
if (department && department.trim().length > 100) throw new Error("Department must not exceed 100 characters");
if (!allowedRoles.has(role)) throw new Error("Role must be employee, manager, executive, or admin");
if (locale !== null && locale !== "tr" && locale !== "en") throw new Error("Locale must be tr or en");
if (requestedPermissions.some((resource) => !allowedResources.has(resource))) {
  throw new Error(`Permissions must be one of: ${[...allowedResources].join(", ")}`);
}

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
  await client.query("BEGIN");
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users
     WHERE phone_lookup_hash::text = ANY($1::text[])
     LIMIT 1
     FOR UPDATE`,
    [identifiers.candidates(phone, "phone-identifier").map((candidate) => candidate.hash)]
  );
  const existingId = existing.rows[0]?.id ?? randomUUID();
  const binding = `users:${existingId}`;
  const phoneLookup = identifiers.hash(phone, "phone-identifier");
  const protectedPhone = encryption.encrypt(phone, "users.phone", binding);
  const protectedFullName = encryption.encrypt(fullName.trim(), "users.full_name", binding);
  const normalizedDepartment = department?.trim() || null;
  const protectedDepartment = normalizedDepartment
    ? encryption.encrypt(normalizedDepartment, "users.department", binding)
    : null;
  const userResult = existing.rows[0]
    ? await client.query<{ id: string }>(
        `UPDATE users
         SET phone_lookup_hash = $2, phone_lookup_key_id = $3,
             phone_ciphertext = $4, phone_key_id = $5,
             full_name_ciphertext = $6, full_name_key_id = $7,
             department_ciphertext = $8, department_key_id = $9,
             role = $10, locale = $11, is_active = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [
          existingId,
          phoneLookup.hash,
          phoneLookup.keyId,
          protectedPhone.ciphertext,
          protectedPhone.keyId,
          protectedFullName.ciphertext,
          protectedFullName.keyId,
          protectedDepartment?.ciphertext ?? null,
          protectedDepartment?.keyId ?? null,
          role,
          locale
        ]
      )
    : await client.query<{ id: string }>(
        `INSERT INTO users (
           id, phone_lookup_hash, phone_lookup_key_id, phone_ciphertext, phone_key_id,
           full_name_ciphertext, full_name_key_id,
           department_ciphertext, department_key_id,
           role, locale, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
         RETURNING id`,
        [
          existingId,
          phoneLookup.hash,
          phoneLookup.keyId,
          protectedPhone.ciphertext,
          protectedPhone.keyId,
          protectedFullName.ciphertext,
          protectedFullName.keyId,
          protectedDepartment?.ciphertext ?? null,
          protectedDepartment?.keyId ?? null,
          role,
          locale
        ]
      );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error("User could not be created");

  for (const resource of requestedPermissions) {
    await client.query(
      `INSERT INTO permissions (user_id, resource, action)
       VALUES ($1, $2, 'read')
       ON CONFLICT (user_id, resource, action) DO NOTHING`,
      [userId, resource]
    );
  }
  await client.query(
    `DELETE FROM permissions
     WHERE user_id = $1
       AND NOT (action = 'read' AND resource = ANY($2::text[]))`,
    [userId, requestedPermissions]
  );
  await appendAuditEvent(client, auditIntegrity, {
    userId,
    eventType: "identity.whitelist_update",
    outcome: "success",
    details: { resources: requestedPermissions }
  });
  await client.query("COMMIT");
  process.stdout.write("Whitelisted user is ready.\n");
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
