import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { parseHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import {
  canonicalAuditAnchor,
  canonicalAuditPayload,
  type CanonicalAuditEvent
} from "../src/messages/audit.repository.js";

const db = new PGlite();
const sql = async (filename: string) =>
  readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");

beforeAll(async () => {
  for (const filename of [
    "001_identity_messages.sql",
    "002_company_reporting.sql",
    "003_app_data_protection.sql",
    "004_identity_lifecycle.sql"
  ]) {
    await db.exec(await sql(filename));
  }
});

afterAll(async () => db.close());

describe("security migration upgrade path", () => {
  it("gates plaintext removal until the application backfill is complete", async () => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (phone_e164, full_name, department, role)
       VALUES ('+905551111111', 'Legacy User', 'Sales', 'employee') RETURNING id`
    );
    const message = await db.query<{ id: string }>(
      `INSERT INTO messages (
         external_message_id_hash, user_id, direction, content, sender_phone_hash
       ) VALUES ($1, $2, 'inbound', 'legacy body', $3) RETURNING id`,
      ["a".repeat(64), user.rows[0]!.id, "b".repeat(64)]
    );
    await db.query(
      `INSERT INTO audit_events (user_id, event_type, outcome, message_id)
       VALUES ($1, 'legacy.event', 'success', $2)`,
      [user.rows[0]!.id, message.rows[0]!.id]
    );

    await db.exec(await sql("005_security_operations.sql"));
    await expect(db.exec(await sql("006_finalize_security_controls.sql"))).rejects.toThrow(
      "backfill is incomplete"
    );

    const encryption = new EnvelopeEncryption(
      parseDataEncryptionConfig(
        JSON.stringify({ current: Buffer.alloc(32, 10).toString("base64") }),
        "current"
      )
    );
    const identifiers = new VersionedHmac(
      parseHmacKeyRing(
        JSON.stringify({ current: Buffer.alloc(32, 11).toString("base64") }),
        "current"
      )
    );
    const integrity = new VersionedHmac(
      parseHmacKeyRing(
        JSON.stringify({ current: Buffer.alloc(32, 12).toString("base64") }),
        "current"
      )
    );
    const userId = user.rows[0]!.id;
    const userBinding = `users:${userId}`;
    const lookup = identifiers.hash("+905551111111", "phone-identifier");
    const phone = encryption.encrypt("+905551111111", "users.phone", userBinding);
    const name = encryption.encrypt("Legacy User", "users.full_name", userBinding);
    const department = encryption.encrypt("Sales", "users.department", userBinding);
    await db.query(
      `UPDATE users SET
         phone_e164 = NULL, full_name = NULL, department = NULL,
         phone_lookup_hash = $2, phone_lookup_key_id = $3,
         phone_ciphertext = $4, phone_key_id = $5,
         full_name_ciphertext = $6, full_name_key_id = $7,
         department_ciphertext = $8, department_key_id = $9
       WHERE id = $1`,
      [
        userId,
        lookup.hash,
        lookup.keyId,
        phone.ciphertext,
        phone.keyId,
        name.ciphertext,
        name.keyId,
        department.ciphertext,
        department.keyId
      ]
    );
    const messageId = message.rows[0]!.id;
    const body = encryption.encrypt("legacy body", "messages.content", `messages:${messageId}`);
    await db.query(
      `UPDATE messages SET content = NULL, content_ciphertext = $2, content_key_id = $3,
         external_message_id_key_id = 'legacy', sender_phone_key_id = 'legacy'
       WHERE id = $1`,
      [messageId, body.ciphertext, body.keyId]
    );

    const audit = await db.query<{
      id: string;
      sequence: string;
      created_at: Date;
    }>("SELECT id, sequence::text, created_at FROM audit_events LIMIT 1");
    const event: CanonicalAuditEvent = {
      id: audit.rows[0]!.id,
      sequence: audit.rows[0]!.sequence,
      previousHash: null,
      userReference: integrity.hash(userId, "audit-user-reference").hash,
      eventType: "legacy.event",
      resource: null,
      outcome: "success",
      messageReference: integrity.hash(messageId, "audit-message-reference").hash,
      details: {},
      createdAt: audit.rows[0]!.created_at.toISOString()
    };
    const eventHash = integrity.hash(canonicalAuditPayload(event), "audit-event");
    const anchorHash = integrity.hash(
      canonicalAuditAnchor(event.sequence, eventHash.hash),
      "audit-anchor"
    );
    await db.query(
      `UPDATE audit_events SET event_hash = $2, anchor_hash = $3, integrity_key_id = $4,
         user_reference = $5, message_reference = $6 WHERE id = $1`,
      [
        event.id,
        eventHash.hash,
        anchorHash.hash,
        eventHash.keyId,
        event.userReference,
        event.messageReference
      ]
    );
    await db.query(
      `UPDATE audit_chain_state SET last_sequence = $1::bigint, last_hash = $2
       WHERE singleton = TRUE`,
      [event.sequence, eventHash.hash]
    );

    await db.exec(await sql("006_finalize_security_controls.sql"));
    const legacyColumns = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('phone_e164', 'full_name', 'department', 'content', 'external_message_id')`
    );
    expect(Number(legacyColumns.rows[0]?.count)).toBe(0);
  });
});
