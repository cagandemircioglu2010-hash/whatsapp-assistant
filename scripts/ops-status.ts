import "dotenv/config";
import pg from "pg";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;

// One-shot operational overview:
//
//   npm run ops:status
//
// Answers "is the deployment healthy and busy" from the database alone —
// migrations, whitelist size, queue depth, 24h traffic, and recent failures —
// without needing the service or Meta to be reachable.

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
assertSafePostgresUrl(databaseUrl);

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

async function count(sql: string): Promise<number> {
  const result = await pool.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

try {
  line("Operational status");
  line("==================");

  const migration = await pool.query<{ filename: string; applied_at: Date }>(
    "SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 1"
  );
  const latest = migration.rows[0];
  line(`Schema         : ${latest ? `${latest.filename} (applied ${latest.applied_at.toISOString().slice(0, 10)})` : "NO MIGRATIONS APPLIED"}`);

  const decommissioned = await pool.query<{ decommissioned: boolean }>(
    `SELECT COALESCE((SELECT decommissioned_at IS NOT NULL FROM service_state WHERE singleton = TRUE), FALSE) AS decommissioned`
  );
  line(`Service state  : ${decommissioned.rows[0]?.decommissioned ? "DECOMMISSIONED" : "active"}`);

  const activeUsers = await count("SELECT COUNT(*) AS count FROM users WHERE is_active");
  const totalUsers = await count("SELECT COUNT(*) AS count FROM users");
  line(`Whitelist      : ${activeUsers} active / ${totalUsers} total (npm run db:list-users for details)`);

  const pending = await count(
    `SELECT COUNT(*) AS count FROM messages
     WHERE direction = 'inbound' AND status IN ('received', 'failed') AND processing_attempts < 3`
  );
  const stuckProcessing = await count(
    `SELECT COUNT(*) AS count FROM messages
     WHERE direction = 'inbound' AND status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'`
  );
  const deliveryUnknown = await count(
    "SELECT COUNT(*) AS count FROM messages WHERE status = 'delivery_unknown'"
  );
  const undeliverable = await count(
    `SELECT COUNT(*) AS count FROM messages
     WHERE direction = 'inbound' AND status = 'failed' AND processing_attempts >= 3`
  );
  line(`Queue          : ${pending} pending, ${stuckProcessing} stuck-processing, ${deliveryUnknown} delivery-unknown, ${undeliverable} undeliverable`);

  const inbound24h = await count(
    "SELECT COUNT(*) AS count FROM messages WHERE direction = 'inbound' AND created_at > NOW() - INTERVAL '24 hours'"
  );
  const outbound24h = await count(
    "SELECT COUNT(*) AS count FROM messages WHERE direction = 'outbound' AND created_at > NOW() - INTERVAL '24 hours'"
  );
  line(`Traffic (24h)  : ${inbound24h} inbound, ${outbound24h} outbound`);

  const failures = await pool.query<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(*) AS count FROM audit_events
     WHERE outcome = 'failure' AND created_at > NOW() - INTERVAL '24 hours'
     GROUP BY event_type ORDER BY count DESC`
  );
  if (failures.rows.length === 0) {
    line("Failures (24h) : none");
  } else {
    line("Failures (24h) :");
    for (const row of failures.rows) line(`  ${row.event_type}: ${row.count}`);
    line("  (structured Meta error codes are in the service logs and audit details)");
  }

  const attention = pending > 100 || stuckProcessing > 0 || failures.rows.length > 0 || !latest;
  line();
  line(attention ? "Status: NEEDS ATTENTION (see above; docs/RUNBOOK.md has the fix flows)" : "Status: healthy");
  process.exitCode = attention ? 1 : 0;
} finally {
  await pool.end();
}
