import "dotenv/config";
import pg from "pg";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;
const databaseUrl =
  process.env.COMPANY_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("COMPANY_DATABASE_ADMIN_URL, DATABASE_ADMIN_URL or DATABASE_URL must be set");
}
assertSafePostgresUrl(databaseUrl);
const ssl = databaseTlsFromEnvironment(process.env, "company");
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query(`
    INSERT INTO company_source.projects (id, name, department, status, owner_name, start_date, due_date)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'Kurumsal Portal', 'Engineering', 'in_progress', 'Demo Owner', CURRENT_DATE - 30, CURRENT_DATE + 20),
      ('10000000-0000-4000-8000-000000000002', 'CRM Geçişi', 'Sales', 'blocked', 'Demo Owner', CURRENT_DATE - 45, CURRENT_DATE + 5)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, due_date = EXCLUDED.due_date, updated_at = NOW()
  `);
  await client.query(`
    INSERT INTO company_source.tasks (id, project_id, title, status, assignee_name, priority, due_date)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Webhook güvenlik testi', 'in_progress', 'Demo User', 'high', CURRENT_DATE - 2),
      ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'CRM veri eşlemesi', 'blocked', 'Demo User', 'critical', CURRENT_DATE - 5)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, due_date = EXCLUDED.due_date, updated_at = NOW()
  `);
  await client.query(`
    INSERT INTO company_source.sales (id, occurred_at, amount, currency, status, customer_reference)
    VALUES
      ('30000000-0000-4000-8000-000000000001', NOW() - INTERVAL '1 day', 12500, 'TRY', 'completed', 'DEMO-001'),
      ('30000000-0000-4000-8000-000000000002', NOW() - INTERVAL '2 days', 8200, 'TRY', 'completed', 'DEMO-002'),
      ('30000000-0000-4000-8000-000000000003', NOW() - INTERVAL '2 days', 900, 'TRY', 'refunded', 'DEMO-003')
    ON CONFLICT (id) DO UPDATE SET occurred_at = EXCLUDED.occurred_at, amount = EXCLUDED.amount, status = EXCLUDED.status
  `);
  await client.query("COMMIT");
  process.stdout.write("Demo company data is ready.\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
