import "dotenv/config";
import pg from "pg";
import { runDataLifecycleJob } from "../src/security/data-lifecycle.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

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
assertSafePostgresUrl(databaseUrl);

const contentDays = retentionDays("MESSAGE_RETENTION_DAYS", 30, 365);
const recordDays = retentionDays("MESSAGE_RECORD_RETENTION_DAYS", 90, 3650);
const auditDays = retentionDays("AUDIT_RETENTION_DAYS", 365, 3650);
if (recordDays < contentDays) {
  throw new Error("MESSAGE_RECORD_RETENTION_DAYS cannot be shorter than MESSAGE_RETENTION_DAYS");
}

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
try {
  const result = await runDataLifecycleJob(pool, {
    contentDays,
    messageRecordDays: recordDays,
    auditDays
  });
  if (!result) throw new Error("Lifecycle purge was skipped because another instance holds the lock");
  if (result.legalHold) {
    process.stdout.write("Lifecycle purge skipped because an approved legal hold is active.\n");
  } else {
    process.stdout.write(
      `Lifecycle purge completed: ${result.contentMinimized} content record(s) minimized, ` +
        `${result.messagesDeleted} terminal message record(s) deleted, ` +
        `${result.auditEventsDeleted} audit record(s) deleted, and ` +
        `${result.rateLimitBucketsDeleted} expired rate-limit bucket(s) deleted.\n`
    );
  }
} finally {
  await pool.end();
}
