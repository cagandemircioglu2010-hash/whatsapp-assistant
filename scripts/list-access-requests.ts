import "dotenv/config";
import pg from "pg";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";

const { Pool } = pg;

// Pending self-service intake for operators:
//
//   npm run db:list-access-requests            # last 14 days, masked phones
//   npm run db:list-access-requests -- --days 30 --full
//
// Surfaces the access requests and right-to-erasure requests users raised from
// WhatsApp, so an admin can act on them with db:add-user / db:erase-user-data
// without granting the running service any write access to the whitelist.

const showFullPhones = process.argv.includes("--full");
const daysIndex = process.argv.indexOf("--days");
const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 14;
if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be an integer between 1 and 365");

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
const security = loadAdminSecurityConfig();
const encryption = new EnvelopeEncryption(security.encryption);

function maskPhone(phone: string): string {
  if (showFullPhones) return phone;
  return phone.length > 7 ? `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}` : "***";
}

function tryDecrypt(ciphertext: string | null, userId: string | null): string {
  if (!ciphertext || !userId) return "unknown";
  try {
    return maskPhone(encryption.decrypt(ciphertext, "users.phone", `users:${userId}`));
  } catch {
    return "[decrypt failed]";
  }
}

const LABELS: Record<string, string> = {
  "identity.access_request": "access request",
  "privacy.erasure_request": "erasure request"
};

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });

try {
  const requests = await pool.query<{
    event_type: string;
    created_at: Date;
    user_id: string | null;
    phone_ciphertext: string | null;
  }>(
    `SELECT a.event_type, a.created_at, a.user_id, u.phone_ciphertext
     FROM audit_events a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.event_type IN ('identity.access_request', 'privacy.erasure_request')
       AND a.created_at >= NOW() - ($1::integer * INTERVAL '1 day')
     ORDER BY a.created_at DESC
     LIMIT 500`,
    [days]
  );

  if (requests.rows.length === 0) {
    process.stdout.write(`No access or erasure requests in the last ${days} day(s).\n`);
  } else {
    process.stdout.write(`${requests.rows.length} request(s) in the last ${days} day(s):\n\n`);
    for (const row of requests.rows) {
      process.stdout.write(
        [
          `- ${LABELS[row.event_type] ?? row.event_type}`,
          `    when  : ${row.created_at.toISOString().slice(0, 16).replace("T", " ")}`,
          `    phone : ${tryDecrypt(row.phone_ciphertext, row.user_id)}`,
          ""
        ].join("\n")
      );
    }
    if (!showFullPhones) process.stdout.write("Phones are masked; re-run with -- --full to show them.\n");
  }
} finally {
  await pool.end();
  encryption.destroy();
}
