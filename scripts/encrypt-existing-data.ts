import "dotenv/config";
import pg from "pg";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import {
  canonicalAuditAnchor,
  canonicalAuditPayload,
  type AuditOutcome,
  type CanonicalAuditEvent
} from "../src/messages/audit.repository.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { ensureSecurityCanary } from "../src/db/readiness.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);

const security = loadAdminSecurityConfig({ allowLegacyIdentifier: true });
const encryption = new EnvelopeEncryption(security.encryption);
const identifiers = new VersionedHmac(security.identifiers);
const auditIntegrity = new VersionedHmac(security.auditIntegrity);
const legacyIdentifierKeyId = process.env.LEGACY_IDENTIFIER_HASH_KEY_ID ?? "legacy";
let legacyIdentifierKeyValidated = false;

function requireLegacyIdentifierKey(): string {
  if (!legacyIdentifierKeyValidated) {
    identifiers.hash("configuration-check", "legacy-key-check", legacyIdentifierKeyId);
    legacyIdentifierKeyValidated = true;
  }
  return legacyIdentifierKeyId;
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseTlsFromEnvironment(process.env),
  max: 1
});
const client = await pool.connect();
const batchSize = 250;

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column]
  );
  return result.rows[0]?.exists === true;
}

async function protectUsers(): Promise<number> {
  const hasLegacyColumns = await columnExists("users", "phone_e164");
  let total = 0;
  while (true) {
    await client.query("BEGIN");
    try {
      const rows = await client.query<{
        id: string;
        phone_e164: string | null;
        phone_ciphertext: string | null;
        full_name: string | null;
        full_name_ciphertext: string | null;
        department: string | null;
        department_ciphertext: string | null;
      }>(
        `SELECT id,
                ${hasLegacyColumns ? "phone_e164" : "NULL::text AS phone_e164"}, phone_ciphertext,
                ${hasLegacyColumns ? "full_name" : "NULL::text AS full_name"}, full_name_ciphertext,
                ${hasLegacyColumns ? "department" : "NULL::text AS department"}, department_ciphertext
         FROM users
         WHERE ${hasLegacyColumns ? "phone_e164 IS NOT NULL OR full_name IS NOT NULL OR department IS NOT NULL OR" : ""}
               phone_ciphertext IS NULL
            OR phone_ciphertext !~ ('^v2[.]' || $2 || '[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$')
            OR phone_key_id IS DISTINCT FROM $2
            OR full_name_ciphertext IS NULL
            OR full_name_ciphertext !~ ('^v2[.]' || $2 || '[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$')
            OR full_name_key_id IS DISTINCT FROM $2
            OR (department_ciphertext IS NOT NULL AND (
                 department_ciphertext !~ ('^v2[.]' || $2 || '[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$')
                 OR department_key_id IS DISTINCT FROM $2
               ))
            OR phone_lookup_key_id IS DISTINCT FROM $3
         ORDER BY id
         FOR UPDATE
         LIMIT $1`,
        [batchSize, security.encryption.activeKeyId, identifiers.activeKeyId]
      );
      for (const row of rows.rows) {
        const binding = `users:${row.id}`;
        const phone = row.phone_e164 ??
          (row.phone_ciphertext
            ? encryption.decrypt(row.phone_ciphertext, "users.phone", binding)
            : null);
        const fullName = row.full_name ??
          (row.full_name_ciphertext
            ? encryption.decrypt(row.full_name_ciphertext, "users.full_name", binding)
            : null);
        const department = row.department ??
          (row.department_ciphertext
            ? encryption.decrypt(row.department_ciphertext, "users.department", binding)
            : null);
        if (!phone || !fullName) throw new Error(`User ${row.id} has no decryptable identity`);
        const phoneLookup = identifiers.hash(phone, "phone-identifier");
        const protectedPhone = encryption.encrypt(phone, "users.phone", binding);
        const protectedName = encryption.encrypt(fullName, "users.full_name", binding);
        const protectedDepartment = department
          ? encryption.encrypt(department, "users.department", binding)
          : null;
        await client.query(
          `UPDATE users SET
             ${hasLegacyColumns ? "phone_e164 = NULL, full_name = NULL, department = NULL," : ""}
             phone_lookup_hash = $2, phone_lookup_key_id = $3,
             phone_ciphertext = $4, phone_key_id = $5,
             full_name_ciphertext = $6, full_name_key_id = $7,
             department_ciphertext = $8, department_key_id = $9, updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            phoneLookup.hash,
            phoneLookup.keyId,
            protectedPhone.ciphertext,
            protectedPhone.keyId,
            protectedName.ciphertext,
            protectedName.keyId,
            protectedDepartment?.ciphertext ?? null,
            protectedDepartment?.keyId ?? null
          ]
        );
      }
      await client.query("COMMIT");
      total += rows.rowCount ?? 0;
      if ((rows.rowCount ?? 0) === 0) return total;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

async function protectMessages(): Promise<number> {
  const hasLegacyContent = await columnExists("messages", "content");
  const hasLegacyExternalId = await columnExists("messages", "external_message_id");
  let total = 0;
  while (true) {
    await client.query("BEGIN");
    try {
      const rows = await client.query<{
        id: string;
        content: string | null;
        content_ciphertext: string | null;
        external_message_id: string | null;
        external_message_id_hash: string | null;
        external_message_id_key_id: string | null;
        sender_phone_hash: string | null;
        sender_phone_key_id: string | null;
      }>(
        `SELECT id,
                ${hasLegacyContent ? "content" : "NULL::text AS content"}, content_ciphertext,
                ${hasLegacyExternalId ? "external_message_id" : "NULL::text AS external_message_id"},
                external_message_id_hash, external_message_id_key_id,
                sender_phone_hash, sender_phone_key_id
         FROM messages
         WHERE ${hasLegacyContent ? "content IS NOT NULL OR" : ""}
               ${hasLegacyExternalId ? "external_message_id IS NOT NULL OR" : ""}
               (content_ciphertext IS NOT NULL AND (
                  content_ciphertext !~ ('^v2[.]' || $2 || '[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]*[.][A-Za-z0-9_-]{22}$')
                  OR content_key_id IS DISTINCT FROM $2
               ))
            OR (external_message_id_hash IS NOT NULL AND external_message_id_key_id IS NULL)
            OR (sender_phone_hash IS NOT NULL AND sender_phone_key_id IS NULL)
         ORDER BY id
         FOR UPDATE
         LIMIT $1`,
        [batchSize, security.encryption.activeKeyId]
      );
      for (const row of rows.rows) {
        const binding = `messages:${row.id}`;
        const content = row.content ??
          (row.content_ciphertext
            ? encryption.decrypt(row.content_ciphertext, "messages.content", binding)
            : null);
        const protectedContent = content === null
          ? null
          : encryption.encrypt(content, "messages.content", binding);
        const externalKeyId = row.external_message_id_key_id ??
          (row.external_message_id_hash ? requireLegacyIdentifierKey() : null);
        const senderKeyId = row.sender_phone_key_id ??
          (row.sender_phone_hash ? requireLegacyIdentifierKey() : null);
        const external = row.external_message_id
          ? identifiers.hash(row.external_message_id, "whatsapp-message-id")
          : row.external_message_id_hash
            ? {
                hash: row.external_message_id_hash,
                keyId: externalKeyId!
              }
            : null;
        await client.query(
          `UPDATE messages SET
             ${hasLegacyContent ? "content = NULL," : ""}
             ${hasLegacyExternalId ? "external_message_id = NULL," : ""}
             content_ciphertext = $2, content_key_id = $3,
             external_message_id_hash = $4, external_message_id_key_id = $5,
             sender_phone_key_id = $6,
             updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            protectedContent?.ciphertext ?? null,
            protectedContent?.keyId ?? null,
            external?.hash ?? null,
            external?.keyId ?? null,
            senderKeyId
          ]
        );
      }
      await client.query("COMMIT");
      total += rows.rowCount ?? 0;
      if ((rows.rowCount ?? 0) === 0) return total;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

async function protectAuditChain(): Promise<number> {
  const unsigned = await client.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM audit_events WHERE event_hash IS NULL OR anchor_hash IS NULL"
  );
  if (Number(unsigned.rows[0]?.count ?? 0) === 0) return 0;
  const anchors = await client.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM audit_chain_anchors"
  );
  if (Number(anchors.rows[0]?.count ?? 0) > 0) {
    throw new Error("Unsigned audit events cannot be rebuilt after audit retention anchors exist");
  }

  await client.query("BEGIN");
  try {
    await client.query("SELECT singleton FROM audit_chain_state WHERE singleton = TRUE FOR UPDATE");
    await client.query(
      `UPDATE audit_events
       SET details = details - 'senderReference'
       WHERE event_hash IS NULL AND event_type = 'whatsapp.authorization'
         AND details ? 'senderReference'`
    );
    const events = await client.query<{
      id: string;
      sequence: string;
      user_id: string | null;
      event_type: string;
      resource: string | null;
      outcome: AuditOutcome;
      message_id: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, sequence::text, user_id, event_type, resource, outcome,
              message_id, details, created_at
       FROM audit_events ORDER BY sequence FOR UPDATE`
    );
    let previousHash: string | null = null;
    for (const row of events.rows) {
      const event: CanonicalAuditEvent = {
        id: row.id,
        sequence: row.sequence,
        previousHash,
        userReference: row.user_id
          ? auditIntegrity.hash(row.user_id, "audit-user-reference").hash
          : null,
        eventType: row.event_type,
        resource: row.resource,
        outcome: row.outcome,
        messageReference: row.message_id
          ? auditIntegrity.hash(row.message_id, "audit-message-reference").hash
          : null,
        details: row.details,
        createdAt: row.created_at.toISOString()
      };
      const protectedHash = auditIntegrity.hash(canonicalAuditPayload(event), "audit-event");
      const protectedAnchor = auditIntegrity.hash(
        canonicalAuditAnchor(event.sequence, protectedHash.hash),
        "audit-anchor"
      );
      await client.query(
        `UPDATE audit_events
         SET previous_hash = $2, event_hash = $3, anchor_hash = $4, integrity_key_id = $5,
             user_reference = $6, message_reference = $7, created_at = $8::timestamptz
         WHERE id = $1`,
        [
          row.id,
          previousHash,
          protectedHash.hash,
          protectedAnchor.hash,
          protectedHash.keyId,
          event.userReference,
          event.messageReference,
          event.createdAt
        ]
      );
      previousHash = protectedHash.hash;
    }
    const last = events.rows.at(-1);
    await client.query(
      `UPDATE audit_chain_state SET last_sequence = $1::bigint, last_hash = $2, updated_at = NOW()
       WHERE singleton = TRUE`,
      [last?.sequence ?? null, previousHash]
    );
    await client.query("COMMIT");
    return events.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function rotateAuditAnchor(): Promise<number> {
  await client.query("BEGIN");
  try {
    const anchor = await client.query<{
      through_sequence: string;
      event_hash: string;
      anchor_hash: string;
      integrity_key_id: string;
    }>(
      `SELECT through_sequence::text, event_hash, anchor_hash, integrity_key_id
       FROM audit_chain_anchors ORDER BY through_sequence DESC LIMIT 1 FOR UPDATE`
    );
    const row = anchor.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return 0;
    }
    const payload = canonicalAuditAnchor(row.through_sequence, row.event_hash);
    if (!auditIntegrity.verify(payload, "audit-anchor", row.anchor_hash, row.integrity_key_id)) {
      throw new Error("Audit retention anchor failed authentication");
    }
    if (row.integrity_key_id === auditIntegrity.activeKeyId) {
      await client.query("COMMIT");
      return 0;
    }
    const rotated = auditIntegrity.hash(payload, "audit-anchor");
    await client.query(
      `UPDATE audit_chain_anchors
       SET anchor_hash = $2, integrity_key_id = $3, created_at = NOW()
       WHERE through_sequence = $1::bigint`,
      [row.through_sequence, rotated.hash, rotated.keyId]
    );
    await client.query("COMMIT");
    return 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

try {
  const lock = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('company-whatsapp-assistant.security-backfill')) AS acquired"
  );
  if (lock.rows[0]?.acquired !== true) throw new Error("Another security backfill is already running");
  await ensureSecurityCanary(client, encryption, identifiers, auditIntegrity);
  const users = await protectUsers();
  const messages = await protectMessages();
  const audits = await protectAuditChain();
  const anchors = await rotateAuditAnchor();
  process.stdout.write(
    `Protected ${users} user record(s), ${messages} message record(s), ${audits} audit record(s), ` +
      `and ${anchors} retention anchor(s).\n`
  );
} finally {
  await client
    .query("SELECT pg_advisory_unlock(hashtext('company-whatsapp-assistant.security-backfill'))")
    .catch(() => undefined);
  client.release();
  await pool.end();
}
