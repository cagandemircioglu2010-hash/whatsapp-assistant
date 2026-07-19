import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRepository } from "../src/auth/user.repository.js";
import { CompanyReportRepository } from "../src/reports/company-report.repository.js";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { parseHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import { PostgresRateLimitStore } from "../src/security/rate-limiter.js";
import { assertRuntimeReady, ensureSecurityCanary } from "../src/db/readiness.js";
import { MessageRepository } from "../src/messages/message.repository.js";
import {
  AuditRepository,
  canonicalAuditAnchor,
  canonicalAuditPayload,
  type CanonicalAuditEvent
} from "../src/messages/audit.repository.js";
import {
  eraseAssistantData,
  readClientDataCounts,
  runDataLifecycleJob
} from "../src/security/data-lifecycle.js";

const db = new PGlite();
const encryption = new EnvelopeEncryption(
  parseDataEncryptionConfig(
    JSON.stringify({ test: Buffer.alloc(32, 4).toString("base64") }),
    "test"
  )
);
const identifiers = new VersionedHmac(
  parseHmacKeyRing(
    JSON.stringify({ current: Buffer.alloc(32, 5).toString("base64") }),
    "current"
  )
);
const auditIntegrity = new VersionedHmac(
  parseHmacKeyRing(
    JSON.stringify({ current: Buffer.alloc(32, 6).toString("base64") }),
    "current"
  )
);

const poolAdapter = {
  query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
  connect: async () => ({
    query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
    release: () => undefined
  })
} as unknown as Pool;

async function insertUser(
  phone: string,
  name: string,
  department: string | null = null,
  role = "employee"
): Promise<string> {
  const id = randomUUID();
  const binding = `users:${id}`;
  const phoneLookup = identifiers.hash(phone, "phone-identifier");
  const protectedPhone = encryption.encrypt(phone, "users.phone", binding);
  const protectedName = encryption.encrypt(name, "users.full_name", binding);
  const protectedDepartment = department
    ? encryption.encrypt(department, "users.department", binding)
    : null;
  await db.query(
    `INSERT INTO users (
       id, phone_lookup_hash, phone_lookup_key_id, phone_ciphertext, phone_key_id,
       full_name_ciphertext, full_name_key_id, department_ciphertext, department_key_id, role
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      phoneLookup.hash,
      phoneLookup.keyId,
      protectedPhone.ciphertext,
      protectedPhone.keyId,
      protectedName.ciphertext,
      protectedName.keyId,
      protectedDepartment?.ciphertext ?? null,
      protectedDepartment?.keyId ?? null,
      role
    ]
  );
  return id;
}

async function appendExpiredAudit(userId: string, messageId: string): Promise<void> {
  await db.query("BEGIN");
  try {
    const state = await db.query<{ last_hash: string | null }>(
      "SELECT last_hash FROM audit_chain_state WHERE singleton = TRUE FOR UPDATE"
    );
    const sequence = await db.query<{ sequence: string }>(
      "SELECT nextval('audit_events_sequence_seq')::text AS sequence"
    );
    const event: CanonicalAuditEvent = {
      id: randomUUID(),
      sequence: sequence.rows[0]!.sequence,
      previousHash: state.rows[0]?.last_hash ?? null,
      userReference: auditIntegrity.hash(userId, "audit-user-reference").hash,
      eventType: "test.expired",
      resource: null,
      outcome: "success",
      messageReference: auditIntegrity.hash(messageId, "audit-message-reference").hash,
      details: {},
      createdAt: new Date(Date.now() - 366 * 86_400_000).toISOString()
    };
    const protectedHash = auditIntegrity.hash(canonicalAuditPayload(event), "audit-event");
    const protectedAnchor = auditIntegrity.hash(
      canonicalAuditAnchor(event.sequence, protectedHash.hash),
      "audit-anchor"
    );
    await db.query(
      `INSERT INTO audit_events (
         id, sequence, previous_hash, event_hash, anchor_hash, integrity_key_id,
         user_id, user_reference, event_type, outcome,
         message_id, message_reference, created_at
       ) VALUES ($1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
      [
        event.id,
        event.sequence,
        event.previousHash,
        protectedHash.hash,
        protectedAnchor.hash,
        protectedHash.keyId,
        userId,
        event.userReference,
        event.eventType,
        event.outcome,
        messageId,
        event.messageReference,
        event.createdAt
      ]
    );
    await db.query(
      `UPDATE audit_chain_state SET last_sequence = $1::bigint, last_hash = $2
       WHERE singleton = TRUE`,
      [event.sequence, protectedHash.hash]
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

beforeAll(async () => {
  for (const filename of [
    "001_identity_messages.sql",
    "002_company_reporting.sql",
    "003_app_data_protection.sql",
    "004_identity_lifecycle.sql",
    "005_security_operations.sql",
    "006_finalize_security_controls.sql",
    "007_user_locale.sql"
  ]) {
    await db.exec(await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8"));
  }
  await db.exec(`
    CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO schema_migrations (filename, checksum)
    VALUES ('006_finalize_security_controls.sql', repeat('0', 64));
  `);
});

afterAll(async () => {
  await db.close();
});

describe("PostgreSQL migrations", () => {
  it("authenticates encryption and audit key configuration before production startup", async () => {
    await assertRuntimeReady(poolAdapter, poolAdapter, encryption, identifiers, auditIntegrity);
    const canary = await db.query<{
      key_id: string;
      integrity_key_id: string;
      identifier_key_id: string;
    }>("SELECT key_id, integrity_key_id, identifier_key_id FROM encryption_canaries");
    expect(canary.rows[0]).toEqual({
      key_id: "test",
      integrity_key_id: "current",
      identifier_key_id: "current"
    });
    const wrongAuditKey = new VersionedHmac(
      parseHmacKeyRing(
        JSON.stringify({ current: Buffer.alloc(32, 99).toString("base64") }),
        "current"
      )
    );
    await expect(
      ensureSecurityCanary(poolAdapter, encryption, identifiers, wrongAuditKey)
    ).rejects.toThrow("Audit integrity canary");
    wrongAuditKey.destroy();
  });

  it("enforces encrypted identity, role, identifier, and message constraints", async () => {
    const userId = await insertUser("+905551234567", "Test User");
    await db.query(
      "INSERT INTO permissions (user_id, resource, action) VALUES ($1, 'company.sales', 'read')",
      [userId]
    );
    await db.query(
      `INSERT INTO messages (
         external_message_id_hash, external_message_id_key_id, user_id, direction,
         sender_phone_hash, sender_phone_key_id
       ) VALUES ($1, 'current', $2, 'inbound', $3, 'current')`,
      ["d".repeat(64), userId, "a".repeat(64)]
    );
    await expect(
      db.query(
        `INSERT INTO messages (
           external_message_id_hash, external_message_id_key_id, direction,
           sender_phone_hash, sender_phone_key_id
         ) VALUES ($1, 'current', 'inbound', $2, 'current')`,
        ["d".repeat(64), "b".repeat(64)]
      )
    ).rejects.toThrow();
    await expect(insertUser("+905551234568", "Bad Role", null, "owner")).rejects.toThrow();

    const legacyColumns = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'users' AND column_name IN ('phone_e164', 'full_name', 'department'))
           OR (table_name = 'messages' AND column_name IN ('content', 'external_message_id')))`
    );
    expect(Number(legacyColumns.rows[0]?.count)).toBe(0);
  });

  it("returns only approved reporting projections", async () => {
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

  it("stores message content as record-bound ciphertext and keeps one reply reservation", async () => {
    const userId = (await db.query<{ id: string }>("SELECT id FROM users LIMIT 1")).rows[0]!.id;
    const messages = new MessageRepository(poolAdapter, encryption, identifiers);
    const senderPhone = identifiers.hash("+905551234567", "sender-phone");
    const inbound = await messages.saveInbound({
      externalMessageId: "wamid.encrypted",
      userId,
      content: "Gizli şirket mesajı",
      senderPhone,
      messageType: "text"
    });
    const externalHash = identifiers.hash("wamid.encrypted", "whatsapp-message-id").hash;
    const stored = await db.query<{
      content_ciphertext: string | null;
      external_message_id_hash: string | null;
      external_message_id_key_id: string | null;
    }>(
      `SELECT content_ciphertext, external_message_id_hash, external_message_id_key_id
       FROM messages WHERE external_message_id_hash = $1`,
      [externalHash]
    );
    expect(stored.rows[0]?.content_ciphertext).toMatch(/^v2\.test\./);
    expect(stored.rows[0]?.content_ciphertext).not.toContain("Gizli");
    expect(stored.rows[0]).toMatchObject({
      external_message_id_hash: externalHash,
      external_message_id_key_id: "current"
    });
    expect(() =>
      encryption.decrypt(stored.rows[0]!.content_ciphertext!, "messages.content", "messages:wrong")
    ).toThrow("authentication");
    expect(
      encryption.decrypt(stored.rows[0]!.content_ciphertext!, "messages.content", `messages:${inbound.id}`)
    ).toBe("Gizli şirket mesajı");

    const reservation = await messages.reserveOutbound({
      replyToMessageId: inbound.id,
      userId,
      content: "Şifreli cevap",
      senderPhone
    });
    expect(reservation).toMatchObject({ status: "sending", shouldSend: true });
    await expect(
      messages.reserveOutbound({ replyToMessageId: inbound.id, userId, content: "Şifreli cevap", senderPhone })
    ).resolves.toMatchObject({ id: reservation.id, status: "sending", shouldSend: false });
    await messages.markOutboundSent(reservation.id, "wamid.encrypted.out");
    await expect(
      messages.reserveOutbound({ replyToMessageId: inbound.id, userId, content: "Şifreli cevap", senderPhone })
    ).resolves.toMatchObject({ status: "sent", shouldSend: false });
    await expect(messages.updateOutboundStatus("wamid.encrypted.out", "delivered")).resolves.toMatchObject({
      id: reservation.id
    });
    await expect(messages.updateOutboundStatus("wamid.encrypted.out", "delivered")).resolves.toBeNull();
    await expect(messages.updateOutboundStatus("wamid.encrypted.out", "sent")).resolves.toBeNull();
  });

  it("decrypts whitelist identity through rotated keyed lookups", async () => {
    const phone = "+905559876543";
    const id = await insertUser(phone, "Encrypted User", "Finance");
    const users = new UserRepository(poolAdapter, identifiers, encryption);
    await expect(users.findActiveByPhone(phone)).resolves.toMatchObject({
      id,
      department: "Finance",
      role: "employee"
    });
    await expect(users.findActiveIdentityById(id)).resolves.toMatchObject({
      phoneE164: phone,
      user: { department: "Finance" }
    });
  });

  it("runs reports inside read-only transactions", async () => {
    const client = {
      query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
      release: () => undefined
    };
    const reports = new CompanyReportRepository({ connect: async () => client } as unknown as Pool);
    // sales_daily buckets by Europe/Istanbul dates, so "today" must be
    // computed in that timezone or the test fails between 21:00 and 24:00 UTC.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
    const [sales, projects, tasks] = await Promise.all([
      reports.getSalesSummary({ startDate: today, endDate: today }),
      reports.getActiveProjects({ limit: 10 }),
      reports.getOverdueTasks({ limit: 10 })
    ]);
    expect(sales.currencies[0]).toMatchObject({ currency: "TRY", completedSalesCount: 1 });
    expect(projects[0]).toMatchObject({ name: "Portal", overdueTaskCount: 1 });
    expect(tasks[0]).toMatchObject({ title: "Security review", daysOverdue: 2 });
  });

  it("shares rate limits across repository instances", async () => {
    const first = new PostgresRateLimitStore(poolAdapter);
    const second = new PostgresRateLimitStore(poolAdapter);
    const subject = "f".repeat(64);
    await expect(first.consume("test.shared", subject, 2)).resolves.toBe(true);
    await expect(second.consume("test.shared", subject, 2)).resolves.toBe(true);
    await expect(first.consume("test.shared", subject, 2)).resolves.toBe(false);
  });

  it("minimizes expired content and deletes only expired terminal/audit records", async () => {
    const userId = (await db.query<{ id: string }>("SELECT id FROM users LIMIT 1")).rows[0]!.id;
    const terminalId = randomUUID();
    const activeId = randomUUID();
    const terminalContent = encryption.encrypt("expired terminal body", "messages.content", `messages:${terminalId}`);
    const activeContent = encryption.encrypt("expired active body", "messages.content", `messages:${activeId}`);
    await db.query(
      `INSERT INTO messages (
         id, user_id, direction, content_ciphertext, content_key_id,
         sender_phone_hash, sender_phone_key_id, status, metadata, created_at
       ) VALUES
         ($1, $3, 'inbound', $4, $5, $6, 'current', 'processed', '{"temporary":true}'::jsonb, NOW() - INTERVAL '91 days'),
         ($2, $3, 'inbound', $7, $8, $9, 'current', 'received', '{"temporary":true}'::jsonb, NOW() - INTERVAL '91 days')`,
      [
        terminalId,
        activeId,
        userId,
        terminalContent.ciphertext,
        terminalContent.keyId,
        "e".repeat(64),
        activeContent.ciphertext,
        activeContent.keyId,
        "f".repeat(64)
      ]
    );
    await appendExpiredAudit(userId, terminalId);
    await expect(
      runDataLifecycleJob(poolAdapter, { contentDays: 30, messageRecordDays: 29, auditDays: 365 })
    ).rejects.toThrow("SQLSTATE 22023");
    await db.query(
      `UPDATE service_state
       SET legal_hold_at = NOW(), legal_hold_reference = 'TEST-HOLD-001'
       WHERE singleton = TRUE`
    );
    await expect(
      runDataLifecycleJob(poolAdapter, { contentDays: 30, messageRecordDays: 90, auditDays: 365 })
    ).resolves.toMatchObject({ legalHold: true, messagesDeleted: 0 });
    expect(
      Number((await db.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM messages WHERE id = $1",
        [terminalId]
      )).rows[0]?.count)
    ).toBe(1);
    await db.query(
      `UPDATE service_state
       SET legal_hold_at = NULL, legal_hold_reference = NULL
       WHERE singleton = TRUE`
    );
    await runDataLifecycleJob(poolAdapter, {
      contentDays: 30,
      messageRecordDays: 90,
      auditDays: 365
    });

    expect(
      Number((await db.query<{ count: number }>("SELECT COUNT(*)::integer AS count FROM messages WHERE id = $1", [terminalId])).rows[0]?.count)
    ).toBe(0);
    const active = await db.query<{ content_ciphertext: string | null; metadata: Record<string, unknown> }>(
      "SELECT content_ciphertext, metadata FROM messages WHERE id = $1",
      [activeId]
    );
    expect(active.rows[0]).toEqual({ content_ciphertext: null, metadata: {} });
    expect(
      Number((await db.query<{ count: number }>("SELECT COUNT(*)::integer AS count FROM audit_events WHERE event_type = 'test.expired'")).rows[0]?.count)
    ).toBe(0);
    expect(
      Number((await db.query<{ count: number }>("SELECT COUNT(*)::integer AS count FROM audit_chain_anchors")).rows[0]?.count)
    ).toBe(1);
    const anchor = await db.query<{
      through_sequence: string;
      event_hash: string;
      anchor_hash: string;
      integrity_key_id: string;
    }>(
      `SELECT through_sequence::text, event_hash, anchor_hash, integrity_key_id
       FROM audit_chain_anchors`
    );
    expect(
      auditIntegrity.verify(
        canonicalAuditAnchor(anchor.rows[0]!.through_sequence, anchor.rows[0]!.event_hash),
        "audit-anchor",
        anchor.rows[0]!.anchor_hash,
        anchor.rows[0]!.integrity_key_id
      )
    ).toBe(true);
    const heartbeat = await db.query<{
      last_succeeded_at: Date | null;
      consecutive_failures: number;
    }>(
      `SELECT last_succeeded_at, consecutive_failures
       FROM maintenance_job_state WHERE job_name = 'data-lifecycle'`
    );
    expect(heartbeat.rows[0]?.last_succeeded_at).not.toBeNull();
    expect(heartbeat.rows[0]?.consecutive_failures).toBe(0);
  });

  it("chains and authenticates audit events while keeping mutable FKs out of the digest", async () => {
    const userId = (await db.query<{ id: string }>("SELECT id FROM users LIMIT 1")).rows[0]!.id;
    const audit = new AuditRepository(poolAdapter, auditIntegrity);
    await audit.record({ userId, eventType: "test.audit.one", outcome: "success", details: { value: 1 } });
    await audit.record({ userId, eventType: "test.audit.two", outcome: "success", details: { value: 2 } });
    const rows = await db.query<{
      id: string;
      sequence: string;
      previous_hash: string | null;
      event_hash: string;
      integrity_key_id: string;
      user_reference: string | null;
      event_type: string;
      resource: string | null;
      outcome: "success";
      message_reference: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, sequence::text, previous_hash, event_hash, integrity_key_id,
              user_reference, event_type, resource, outcome, message_reference,
              details, created_at
       FROM audit_events WHERE event_type LIKE 'test.audit.%' ORDER BY sequence`
    );
    expect(rows.rows[1]?.previous_hash).toBe(rows.rows[0]?.event_hash);
    const last = rows.rows[1]!;
    const canonical: CanonicalAuditEvent = {
      id: last.id,
      sequence: last.sequence,
      previousHash: last.previous_hash,
      userReference: last.user_reference,
      eventType: last.event_type,
      resource: last.resource,
      outcome: last.outcome,
      messageReference: last.message_reference,
      details: last.details,
      createdAt: last.created_at.toISOString()
    };
    expect(
      auditIntegrity.verify(canonicalAuditPayload(canonical), "audit-event", last.event_hash, last.integrity_key_id)
    ).toBe(true);
    expect(
      auditIntegrity.verify(
        canonicalAuditPayload({ ...canonical, details: { value: 999 } }),
        "audit-event",
        last.event_hash,
        last.integrity_key_id
      )
    ).toBe(false);
  });

  it("erases all assistant-owned security data without touching reporting source", async () => {
    const before = await readClientDataCounts(poolAdapter);
    expect(before.users).toBeGreaterThan(0);
    const erased = await eraseAssistantData(poolAdapter);
    expect(erased.before).toEqual(before);
    expect(erased.after).toEqual({
      users: 0,
      permissions: 0,
      messages: 0,
      audit_events: 0,
      rate_limit_buckets: 0,
      encryption_canaries: 0,
      audit_chain_anchors: 0
    });
    await expect(readClientDataCounts(poolAdapter)).resolves.toEqual(erased.after);
    const sourceProjects = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM company_source.projects"
    );
    expect(Number(sourceProjects.rows[0]?.count)).toBeGreaterThan(0);
  });
});
