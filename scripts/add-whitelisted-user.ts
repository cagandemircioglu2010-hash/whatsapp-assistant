import "dotenv/config";
import pg from "pg";
import { hashPhoneIdentifier, normalizePhoneNumber, phoneLastFour } from "../src/security/phone.js";
import { reportResources } from "../src/auth/types.js";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
const phoneHashSecret = process.env.PHONE_HASH_SECRET;
const activeKeyId = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID;
const keysJson = process.env.DATA_ENCRYPTION_KEYS;
if (!phoneHashSecret || phoneHashSecret.length < 32) throw new Error("PHONE_HASH_SECRET must be set");
if (!activeKeyId || !keysJson) throw new Error("Data encryption keys must be set");
const encryption = new EnvelopeEncryption(parseDataEncryptionConfig(keysJson, activeKeyId));

const rawPhone = argument("phone");
const fullName = argument("name");
const department = argument("department") ?? null;
const role = argument("role") ?? "employee";
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
if (requestedPermissions.some((resource) => !allowedResources.has(resource))) {
  throw new Error(`Permissions must be one of: ${[...allowedResources].join(", ")}`);
}

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  const phoneLookupHash = hashPhoneIdentifier(phone, phoneHashSecret);
  const protectedPhone = encryption.encrypt(phone, "users.phone");
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users
     WHERE phone_lookup_hash = $1 OR (phone_lookup_hash IS NULL AND phone_e164 = $2)
     LIMIT 1
     FOR UPDATE`,
    [phoneLookupHash, phone]
  );
  const existingId = existing.rows[0]?.id;
  const userResult = existingId
    ? await client.query<{ id: string }>(
        `UPDATE users
         SET phone_e164 = NULL, phone_lookup_hash = $2, phone_ciphertext = $3, phone_key_id = $4,
             full_name = $5, department = $6, role = $7, is_active = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [
          existingId,
          phoneLookupHash,
          protectedPhone.ciphertext,
          protectedPhone.keyId,
          fullName.trim(),
          department?.trim() ?? null,
          role
        ]
      )
    : await client.query<{ id: string }>(
        `INSERT INTO users (
           phone_e164, phone_lookup_hash, phone_ciphertext, phone_key_id,
           full_name, department, role, is_active
         ) VALUES (NULL, $1, $2, $3, $4, $5, $6, TRUE)
         RETURNING id`,
        [
          phoneLookupHash,
          protectedPhone.ciphertext,
          protectedPhone.keyId,
          fullName.trim(),
          department?.trim() ?? null,
          role
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
     WHERE user_id = $1 AND action = 'read' AND NOT (resource = ANY($2::text[]))`,
    [userId, requestedPermissions]
  );
  await client.query(
    `INSERT INTO audit_events (user_id, event_type, outcome, details)
     VALUES ($1, 'identity.whitelist_update', 'success', $2::jsonb)`,
    [userId, JSON.stringify({ resources: requestedPermissions })]
  );
  await client.query("COMMIT");
  process.stdout.write(`Whitelisted user ending in ${phoneLastFour(phone)} is ready.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
