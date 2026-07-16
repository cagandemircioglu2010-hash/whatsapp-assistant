import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanyReportRepository } from "../src/reports/company-report.repository.js";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { MessageRepository } from "../src/messages/message.repository.js";

const db = new PGlite();

beforeAll(async () => {
  const identityMigration = await readFile(new URL("../migrations/001_identity_messages.sql", import.meta.url), "utf8");
  const reportingMigration = await readFile(new URL("../migrations/002_company_reporting.sql", import.meta.url), "utf8");
  const protectionMigration = await readFile(new URL("../migrations/003_app_data_protection.sql", import.meta.url), "utf8");
  await db.exec(identityMigration);
  await db.exec(reportingMigration);
  await db.exec(protectionMigration);
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

  it("stores new message content only as authenticated ciphertext", async () => {
    const user = await db.query<{ id: string }>("SELECT id FROM users LIMIT 1");
    const userId = user.rows[0]?.id;
    expect(userId).toBeTruthy();
    const encryption = new EnvelopeEncryption(
      parseDataEncryptionConfig(
        JSON.stringify({ test: Buffer.alloc(32, 4).toString("base64") }),
        "test"
      )
    );
    const poolAdapter = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters)
    } as unknown as Pool;
    const messages = new MessageRepository(poolAdapter, encryption);

    const inbound = await messages.saveInbound({
      externalMessageId: "wamid.encrypted",
      userId: userId!,
      content: "Gizli şirket mesajı",
      senderPhoneHash: "c".repeat(64),
      messageType: "text"
    });
    const stored = await db.query<{ content: string | null; content_ciphertext: string | null }>(
      "SELECT content, content_ciphertext FROM messages WHERE external_message_id = 'wamid.encrypted'"
    );
    expect(stored.rows[0]?.content).toBeNull();
    expect(stored.rows[0]?.content_ciphertext).toMatch(/^v1\.test\./);
    expect(stored.rows[0]?.content_ciphertext).not.toContain("Gizli");

    const history = await messages.listRecentForUser(userId!, 10);
    expect(history.find((row) => row.external_message_id === "wamid.encrypted")?.content).toBe(
      "Gizli şirket mesajı"
    );

    const reservation = await messages.reserveOutbound({
      replyToMessageId: inbound.id,
      userId: userId!,
      content: "Şifreli cevap",
      senderPhoneHash: "c".repeat(64)
    });
    expect(reservation).toMatchObject({ status: "sending", shouldSend: true });
    const concurrentReservation = await messages.reserveOutbound({
      replyToMessageId: inbound.id,
      userId: userId!,
      content: "Şifreli cevap",
      senderPhoneHash: "c".repeat(64)
    });
    expect(concurrentReservation).toMatchObject({
      id: reservation.id,
      status: "sending",
      shouldSend: false
    });

    await messages.markOutboundSent(reservation.id, "wamid.encrypted.out");
    const afterDelivery = await messages.reserveOutbound({
      replyToMessageId: inbound.id,
      userId: userId!,
      content: "Şifreli cevap",
      senderPhoneHash: "c".repeat(64)
    });
    expect(afterDelivery).toMatchObject({ status: "sent", shouldSend: false });
    await expect(messages.updateOutboundStatus("wamid.encrypted.out", "delivered")).resolves.toMatchObject({
      id: reservation.id
    });
    const outboxCount = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM messages WHERE reply_to_message_id = $1",
      [inbound.id]
    );
    expect(Number(outboxCount.rows[0]?.count)).toBe(1);
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
