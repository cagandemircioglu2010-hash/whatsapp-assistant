import "dotenv/config";
import pg from "pg";
import { hashPhoneIdentifier, normalizePhoneNumber } from "../src/security/phone.js";

const { Pool } = pg;
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databaseUrl = process.env.DATABASE_ADMIN_URL;
const secret = process.env.PHONE_HASH_SECRET;
const rawPhone = argument("phone");
const requestedState = argument("active");
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
if (!secret || secret.length < 32) throw new Error("PHONE_HASH_SECRET must be set");
if (!rawPhone || !new Set(["true", "false"]).has(requestedState ?? "")) {
  throw new Error('Usage: npm run db:set-user-active -- --phone "+905..." --active true|false');
}
const phone = normalizePhoneNumber(rawPhone, (process.env.DEFAULT_PHONE_COUNTRY ?? "TR") as "TR");
if (!phone) throw new Error("Phone number is not valid");
const active = requestedState === "true";

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const updated = await client.query<{ id: string }>(
    `UPDATE users
     SET is_active = $2, updated_at = NOW()
     WHERE phone_lookup_hash = $1 OR (phone_lookup_hash IS NULL AND phone_e164 = $3)
     RETURNING id`,
    [hashPhoneIdentifier(phone, secret), active, phone]
  );
  const userId = updated.rows[0]?.id;
  if (!userId) throw new Error("Whitelist user was not found");
  await client.query(
    `INSERT INTO audit_events (user_id, event_type, outcome, details)
     VALUES ($1, 'identity.activation_update', 'success', $2::jsonb)`,
    [userId, JSON.stringify({ active })]
  );
  await client.query("COMMIT");
  process.stdout.write(`User is now ${active ? "active" : "inactive"}.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
