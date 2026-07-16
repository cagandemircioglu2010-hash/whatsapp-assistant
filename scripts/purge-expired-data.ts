import "dotenv/config";
import pg from "pg";
import { purgeExpiredData } from "../src/security/data-lifecycle.js";

const { Pool } = pg;

function retentionDays(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");

const contentDays = retentionDays("MESSAGE_RETENTION_DAYS", 30, 365);
const recordDays = retentionDays("MESSAGE_RECORD_RETENTION_DAYS", 90, 3650);
const auditDays = retentionDays("AUDIT_RETENTION_DAYS", 365, 3650);
if (recordDays < contentDays) {
  throw new Error("MESSAGE_RECORD_RETENTION_DAYS cannot be shorter than MESSAGE_RETENTION_DAYS");
}

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '5min'");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('company-whatsapp-assistant.data-lifecycle'))"
  );

  const result = await purgeExpiredData(client, {
    contentDays,
    messageRecordDays: recordDays,
    auditDays
  });

  await client.query("COMMIT");
  process.stdout.write(
    `Lifecycle purge completed: ${result.contentMinimized} content record(s) minimized, ` +
      `${result.messagesDeleted} terminal message record(s) deleted, ` +
      `${result.auditEventsDeleted} audit record(s) deleted.\n`
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
