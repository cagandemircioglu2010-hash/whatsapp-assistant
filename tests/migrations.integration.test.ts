import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanyReportRepository } from "../src/reports/company-report.repository.js";

const db = new PGlite();

beforeAll(async () => {
  const identityMigration = await readFile(new URL("../migrations/001_identity_messages.sql", import.meta.url), "utf8");
  const reportingMigration = await readFile(new URL("../migrations/002_company_reporting.sql", import.meta.url), "utf8");
  await db.exec(identityMigration);
  await db.exec(reportingMigration);
});

afterAll(async () => {
  await db.close();
});

describe("PostgreSQL migrations", () => {
  it("creates whitelist, permissions and message history constraints", async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (phone_e164, full_name, role)
       VALUES ('+905551234567', 'Test User', 'employee')
       RETURNING id`
    );
    const userId = user.rows[0]?.id;
    expect(userId).toBeTruthy();

    await db.query(
      `INSERT INTO permissions (user_id, resource, action)
       VALUES ($1, 'company.sales', 'read')`,
      [userId]
    );
    await db.query(
      `INSERT INTO messages (
         external_message_id, user_id, direction, content, sender_phone_hash
       ) VALUES ('wamid.test', $1, 'inbound', 'Satış özeti', $2)`,
      [userId, "a".repeat(64)]
    );

    await expect(
      db.query(
        `INSERT INTO messages (external_message_id, direction, sender_phone_hash)
         VALUES ('wamid.test', 'inbound', $1)`,
        ["b".repeat(64)]
      )
    ).rejects.toThrow();
  });

  it("returns only aggregated sales, active projects and overdue tasks through views", async () => {
    await db.exec(`
      INSERT INTO company_source.projects (id, name, department, status)
      VALUES ('10000000-0000-4000-8000-000000000001', 'Portal', 'Engineering', 'in_progress');

      INSERT INTO company_source.tasks (project_id, title, status, priority, due_date)
      VALUES ('10000000-0000-4000-8000-000000000001', 'Security review', 'in_progress', 'high', CURRENT_DATE - 2);

      INSERT INTO company_source.sales (occurred_at, amount, currency, status, customer_reference)
      VALUES (NOW(), 1200, 'TRY', 'completed', 'PRIVATE-CUSTOMER');
    `);

    const sales = await db.query<{ completed_sales_count: number; completed_revenue: string }>(
      "SELECT completed_sales_count, completed_revenue::text FROM assistant_reporting.sales_daily"
    );
    const projects = await db.query<{ name: string; overdue_task_count: number }>(
      "SELECT name, overdue_task_count FROM assistant_reporting.active_projects"
    );
    const tasks = await db.query<{ title: string; days_overdue: number }>(
      "SELECT title, days_overdue FROM assistant_reporting.overdue_tasks"
    );

    expect(Number(sales.rows[0]?.completed_sales_count)).toBe(1);
    expect(sales.rows[0]?.completed_revenue).toBe("1200.00");
    expect(Number(projects.rows[0]?.overdue_task_count)).toBe(1);
    expect(tasks.rows[0]).toMatchObject({ title: "Security review", days_overdue: 2 });
    expect(JSON.stringify(sales.rows)).not.toContain("PRIVATE-CUSTOMER");
  });

  it("executes the three repository queries inside read-only transactions", async () => {
    const client = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
      release: () => undefined
    };
    const poolAdapter = { connect: async () => client } as unknown as Pool;
    const reports = new CompanyReportRepository(poolAdapter);
    const today = new Date().toISOString().slice(0, 10);

    const sales = await reports.getSalesSummary({ startDate: today, endDate: today });
    const projects = await reports.getActiveProjects({ limit: 10 });
    const tasks = await reports.getOverdueTasks({ limit: 10 });

    expect(sales.currencies[0]).toMatchObject({
      currency: "TRY",
      completedSalesCount: 1,
      completedRevenue: "1200.00"
    });
    expect(projects[0]).toMatchObject({ name: "Portal", overdueTaskCount: 1 });
    expect(tasks[0]).toMatchObject({ title: "Security review", daysOverdue: 2 });
  });
});
