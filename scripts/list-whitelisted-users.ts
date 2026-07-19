import "dotenv/config";
import pg from "pg";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";

const { Pool } = pg;

// Admin overview of the whitelist:
//
//   npm run db:list-users              # masked phone numbers
//   npm run db:list-users -- --full    # full decrypted phone numbers
//
// Answers "why does the bot ignore this person" without SQL: shows each
// user's status, role, and permissions next to the (masked) phone number.

const showFullPhones = process.argv.includes("--full");

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
const security = loadAdminSecurityConfig();
const encryption = new EnvelopeEncryption(security.encryption);

function maskPhone(phone: string): string {
  if (showFullPhones) return phone;
  return phone.length > 7 ? `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}` : "***";
}

function tryDecrypt(ciphertext: string | null, purpose: string, binding: string): string {
  if (!ciphertext) return "-";
  try {
    return encryption.decrypt(ciphertext, purpose, binding);
  } catch {
    return "[decrypt failed]";
  }
}

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });

try {
  const users = await pool.query<{
    id: string;
    role: string;
    is_active: boolean;
    created_at: Date;
    phone_ciphertext: string | null;
    full_name_ciphertext: string | null;
    department_ciphertext: string | null;
    permissions: string[] | null;
  }>(
    `SELECT u.id, u.role, u.is_active, u.created_at,
            u.phone_ciphertext, u.full_name_ciphertext, u.department_ciphertext,
            ARRAY_AGG(p.resource ORDER BY p.resource) FILTER (WHERE p.resource IS NOT NULL) AS permissions
     FROM users u
     LEFT JOIN permissions p ON p.user_id = u.id AND p.action = 'read'
     GROUP BY u.id
     ORDER BY u.created_at`
  );

  if (users.rows.length === 0) {
    process.stdout.write("No whitelisted users. Add one with: npm run db:add-user -- --phone \"+90...\" --name \"Name\"\n");
  } else {
    process.stdout.write(`${users.rows.length} user(s):\n\n`);
    for (const row of users.rows) {
      const binding = `users:${row.id}`;
      const phone = tryDecrypt(row.phone_ciphertext, "users.phone", binding);
      const name = tryDecrypt(row.full_name_ciphertext, "users.full_name", binding);
      const department = tryDecrypt(row.department_ciphertext, "users.department", binding);
      process.stdout.write(
        [
          `- ${name} (${row.is_active ? "active" : "INACTIVE"})`,
          `    phone       : ${phone === "-" ? "-" : maskPhone(phone)}`,
          `    role        : ${row.role}${department !== "-" ? `  department: ${department}` : ""}`,
          `    permissions : ${row.permissions?.join(", ") ?? "(none — every report request will be denied)"}`,
          `    since       : ${row.created_at.toISOString().slice(0, 10)}`,
          ""
        ].join("\n")
      );
    }
    if (!showFullPhones) {
      process.stdout.write("Phones are masked; re-run with -- --full to show them.\n");
    }
  }
} finally {
  await pool.end();
  encryption.destroy();
}
