import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompanyReportRepository } from "../src/reports/company-report.repository.js";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { MessageRepository } from "../src/messages/message.repository.js";
import { UserRepository } from "../src/auth/user.repository.js";
import { hashOpaqueIdentifier, hashPhoneIdentifier } from "../src/security/phone.js";
import {
  eraseAssistantData,
  purgeExpiredData,
  readClientDataCounts
} from "../src/security/data-lifecycle.js";

const db = new PGlite();

beforeAll(async () => {
  const identityMigration = await readFile(new URL("../migrations/001_identity_messages.sql", import.meta.url), "utf8");
  const reportingMigration = await readFile(new URL("../migrations/002_company_reporting.sql", import.meta.url), "utf8");
  const protectionMigration = await readFile(new URL("../migrations/003_app_data_protection.sql", import.meta.url), "utf8");
  const lifecycleMigration = await readFile(new URL("../migrations/004_identity_lifecycle.sql", import.meta.url), "utf8");
  await db.exec(identityMigration);
  await db.exec(reportingMigration);
  await db.exec(protectionMigration);
  await db.exec(lifecycleMigration);
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
         external_message_id_hash, user_id, direction, content, sender_phone_hash
       ) VALUES ($1, $2, 'inbound', 'Satış özeti', $3)`,
      ["d".repeat(64), userId, "a".repeat(64)]
    );

    await expect(
      db.query(
        `INSERT INTO messages (external_message_id_hash, direction, sender_phone_hash)
         VALUES ($1, 'inbound', $2)`,
        ["d".repeat(64), "b".repeat(64)]
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
    const identifierSecret = "i".repeat(32);
    const messages = new MessageRepository(poolAdapter, encryption, identifierSecret);

    const inbound = await messages.saveInbound({
      externalMessageId: "wamid.encrypted",
      userId: userId!,
      content: "Gizli şirket mesajı",
      senderPhoneHash: "c".repeat(64),
      messageType: "text"
    });
    const externalHash = hashOpaqueIdentifier(
      "wamid.encrypted",
      identifierSecret,
      "whatsapp-message-id"
    );
    const stored = await db.query<{
      content: string | null;
      content_ciphertext: string | null;
      external_message_id: string | null;
      external_message_id_hash: string | null;
    }>(
      `SELECT content, content_ciphertext, external_message_id, external_message_id_hash
       FROM messages WHERE external_message_id_hash = $1`,
      [externalHash]
    );
    expect(stored.rows[0]?.content).toBeNull();
    expect(stored.rows[0]?.content_ciphertext).toMatch(/^v1\.test\./);
    expect(stored.rows[0]?.content_ciphertext).not.toContain("Gizli");
    expect(stored.rows[0]?.external_message_id).toBeNull();
    expect(stored.rows[0]?.external_message_id_hash).toBe(externalHash);

    const history = await messages.listRecentForUser(userId!, 10);
    const inboundHistory = history.find((row) => row.id === inbound.id);
    expect(inboundHistory?.content).toBe("Gizli şirket mesajı");
    expect(inboundHistory).not.toHaveProperty("external_message_id");
    expect(inboundHistory).not.toHaveProperty("external_message_id_hash");

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

    await db.query(
      `UPDATE messages
       SET created_at = NOW() - INTERVAL '31 days', metadata = '{"legacy":true}'::jsonb
       WHERE id = $1`,
      [inbound.id]
    );
    await messages.purgeExpiredContent(30);
    const minimized = await db.query<{
      content_ciphertext: string | null;
      content_key_id: string | null;
      metadata: Record<string, unknown>;
    }>("SELECT content_ciphertext, content_key_id, metadata FROM messages WHERE id = $1", [inbound.id]);
    expect(minimized.rows[0]).toMatchObject({
      content_ciphertext: null,
      content_key_id: null,
      metadata: {}
    });
  });

  it("stores and decrypts whitelist identity fields without plaintext columns", async () => {
    const identifierSecret = "u".repeat(32);
    const phone = "+905559876543";
    const encryption = new EnvelopeEncryption(
      parseDataEncryptionConfig(
        JSON.stringify({ test: Buffer.alloc(32, 8).toString("base64") }),
        "test"
      )
    );
    const protectedPhone = encryption.encrypt(phone, "users.phone");
    const protectedName = encryption.encrypt("Encrypted User", "users.full_name");
    const protectedDepartment = encryption.encrypt("Finance", "users.department");
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO users (
         phone_e164, phone_lookup_hash, phone_ciphertext, phone_key_id,
         full_name, full_name_ciphertext, full_name_key_id,
         department, department_ciphertext, department_key_id, role
       ) VALUES (NULL, $1, $2, $3, NULL, $4, $5, NULL, $6, $7, 'employee')
       RETURNING id`,
      [
        hashPhoneIdentifier(phone, identifierSecret),
        protectedPhone.ciphertext,
        protectedPhone.keyId,
        protectedName.ciphertext,
        protectedName.keyId,
        protectedDepartment.ciphertext,
        protectedDepartment.keyId
      ]
    );
    const poolAdapter = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters)
    } as unknown as Pool;
    const users = new UserRepository(poolAdapter, identifierSecret, encryption);

    await expect(users.findActiveByPhone(phone)).resolves.toMatchObject({
      id: inserted.rows[0]?.id,
      fullName: "Encrypted User",
      department: "Finance",
      role: "employee"
    });
    await expect(users.findActiveIdentityById(inserted.rows[0]!.id)).resolves.toMatchObject({
      phoneE164: phone,
      user: { fullName: "Encrypted User", department: "Finance" }
    });
    const plaintext = await db.query<{
      phone_e164: string | null;
      full_name: string | null;
      department: string | null;
    }>("SELECT phone_e164, full_name, department FROM users WHERE id = $1", [inserted.rows[0]!.id]);
    expect(plaintext.rows[0]).toEqual({ phone_e164: null, full_name: null, department: null });
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

  it("minimizes expired content and deletes only expired terminal/audit records", async () => {
    const user = await db.query<{ id: string }>("SELECT id FROM users LIMIT 1");
    const userId = user.rows[0]?.id;
    expect(userId).toBeTruthy();
    const terminal = await db.query<{ id: string }>(
      `INSERT INTO messages (
         user_id, direction, content, sender_phone_hash, status, metadata, created_at
       ) VALUES ($1, 'inbound', 'expired terminal body', $2, 'processed',
                 '{"temporary":true}'::jsonb, NOW() - INTERVAL '91 days')
       RETURNING id`,
      [userId, "e".repeat(64)]
    );
    const active = await db.query<{ id: string }>(
      `INSERT INTO messages (
         user_id, direction, content, sender_phone_hash, status, metadata, created_at
       ) VALUES ($1, 'inbound', 'expired active body', $2, 'received',
                 '{"temporary":true}'::jsonb, NOW() - INTERVAL '91 days')
       RETURNING id`,
      [userId, "f".repeat(64)]
    );
    await db.query(
      `INSERT INTO audit_events (user_id, event_type, outcome, message_id, created_at)
       VALUES ($1, 'test.expired', 'success', $2, NOW() - INTERVAL '366 days')`,
      [userId, terminal.rows[0]!.id]
    );
    const poolAdapter = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters)
    } as unknown as Pool;

    await expect(
      purgeExpiredData(poolAdapter, { contentDays: 30, messageRecordDays: 29, auditDays: 365 })
    ).rejects.toThrow("cannot be shorter");
    await purgeExpiredData(poolAdapter, {
      contentDays: 30,
      messageRecordDays: 90,
      auditDays: 365
    });

    const terminalAfter = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM messages WHERE id = $1",
      [terminal.rows[0]!.id]
    );
    expect(Number(terminalAfter.rows[0]?.count)).toBe(0);
    const activeAfter = await db.query<{
      content: string | null;
      metadata: Record<string, unknown>;
    }>("SELECT content, metadata FROM messages WHERE id = $1", [active.rows[0]!.id]);
    expect(activeAfter.rows[0]).toEqual({ content: null, metadata: {} });
    const expiredAudits = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM audit_events WHERE event_type = 'test.expired'"
    );
    expect(Number(expiredAudits.rows[0]?.count)).toBe(0);
  });

  it("erases assistant-owned client data without touching the reporting source", async () => {
    const poolAdapter = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters)
    } as unknown as Pool;
    const before = await readClientDataCounts(poolAdapter);
    expect(before.users).toBeGreaterThan(0);

    const erased = await eraseAssistantData(poolAdapter);
    expect(erased.before).toEqual(before);
    expect(erased.after).toEqual({ users: 0, permissions: 0, messages: 0, audit_events: 0 });
    await expect(readClientDataCounts(poolAdapter)).resolves.toEqual(erased.after);

    const sourceProjects = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM company_source.projects"
    );
    expect(Number(sourceProjects.rows[0]?.count)).toBeGreaterThan(0);
  });
});
