import "dotenv/config";
import pg from "pg";
import { normalizePhoneNumber, phoneLastFour } from "../src/security/phone.js";
import { reportResources } from "../src/auth/types.js";

const { Pool } = pg;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set");

const rawPhone = argument("phone");
const fullName = argument("name");
const department = argument("department") ?? null;
const role = argument("role") ?? "employee";
const requestedPermissions = (argument("permissions") ?? Object.values(reportResources).join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedResources = new Set<string>(Object.values(reportResources));

if (!rawPhone || !fullName) {
  throw new Error(
    'Usage: npm run db:add-user -- --phone "+905..." --name "Name" [--department "Sales"] [--permissions "company.sales,..."]'
  );
}
const phone = normalizePhoneNumber(rawPhone, (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as "TR");
if (!phone) throw new Error("Phone number is not valid");
if (fullName.trim().length < 2 || fullName.trim().length > 120) throw new Error("Name must be 2-120 characters");
if (requestedPermissions.some((resource) => !allowedResources.has(resource))) {
  throw new Error(`Permissions must be one of: ${[...allowedResources].join(", ")}`);
}

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  const userResult = await client.query<{ id: string }>(
    `INSERT INTO users (phone_e164, full_name, department, role, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (phone_e164)
     DO UPDATE SET
       full_name = EXCLUDED.full_name,
       department = EXCLUDED.department,
       role = EXCLUDED.role,
       is_active = TRUE,
       updated_at = NOW()
     RETURNING id`,
    [phone, fullName.trim(), department, role]
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
  await client.query("COMMIT");
  process.stdout.write(`Whitelisted user ending in ${phoneLastFour(phone)} is ready.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
