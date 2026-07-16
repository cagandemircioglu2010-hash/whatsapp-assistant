import "dotenv/config";
import pg from "pg";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { hashOpaqueIdentifier, hashPhoneIdentifier } from "../src/security/phone.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_ADMIN_URL;
const phoneHashSecret = process.env.PHONE_HASH_SECRET;
const activeKeyId = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID;
const keysJson = process.env.DATA_ENCRYPTION_KEYS;

if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
if (!phoneHashSecret || phoneHashSecret.length < 32) throw new Error("PHONE_HASH_SECRET must be set");
if (!activeKeyId || !keysJson) throw new Error("Data encryption keys must be set");

const encryption = new EnvelopeEncryption(parseDataEncryptionConfig(keysJson, activeKeyId));
const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const batchSize = 250;

async function encryptUsers(): Promise<number> {
  let total = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{
        id: string;
        phone_e164: string | null;
        phone_ciphertext: string | null;
        full_name: string | null;
        full_name_ciphertext: string | null;
        department: string | null;
        department_ciphertext: string | null;
      }>(
        `SELECT id, phone_e164, phone_ciphertext,
                full_name, full_name_ciphertext, department, department_ciphertext
         FROM users
         WHERE phone_e164 IS NOT NULL
            OR (phone_ciphertext IS NOT NULL AND phone_key_id IS DISTINCT FROM $2)
            OR full_name IS NOT NULL
            OR (full_name_ciphertext IS NOT NULL AND full_name_key_id IS DISTINCT FROM $2)
            OR department IS NOT NULL
            OR (department_ciphertext IS NOT NULL AND department_key_id IS DISTINCT FROM $2)
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [batchSize, activeKeyId]
      );
      for (const row of rows.rows) {
        const phone = row.phone_e164 ??
          (row.phone_ciphertext ? encryption.decrypt(row.phone_ciphertext, "users.phone") : null);
        if (!phone) throw new Error("A phone record has no decryptable representation");
        const fullName = row.full_name ??
          (row.full_name_ciphertext
            ? encryption.decrypt(row.full_name_ciphertext, "users.full_name")
            : null);
        if (!fullName) throw new Error("A user record has no decryptable name");
        const department = row.department ??
          (row.department_ciphertext
            ? encryption.decrypt(row.department_ciphertext, "users.department")
            : null);
        const protectedPhone = encryption.encrypt(phone, "users.phone");
        const protectedFullName = encryption.encrypt(fullName, "users.full_name");
        const protectedDepartment = department === null
          ? null
          : encryption.encrypt(department, "users.department");
        await client.query(
          `UPDATE users
           SET phone_lookup_hash = $2, phone_ciphertext = $3, phone_key_id = $4,
               phone_e164 = NULL,
               full_name = NULL, full_name_ciphertext = $5, full_name_key_id = $6,
               department = NULL, department_ciphertext = $7, department_key_id = $8,
               updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            hashPhoneIdentifier(phone, phoneHashSecret!),
            protectedPhone.ciphertext,
            protectedPhone.keyId,
            protectedFullName.ciphertext,
            protectedFullName.keyId,
            protectedDepartment?.ciphertext ?? null,
            protectedDepartment?.keyId ?? null
          ]
        );
      }
      await client.query("COMMIT");
      total += rows.rowCount ?? 0;
      if ((rows.rowCount ?? 0) < batchSize) return total;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function encryptMessages(): Promise<number> {
  let total = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{
        id: string;
        content: string | null;
        content_ciphertext: string | null;
        external_message_id: string | null;
        external_message_id_hash: string | null;
      }>(
        `SELECT id, content, content_ciphertext, external_message_id, external_message_id_hash
         FROM messages
         WHERE content IS NOT NULL
            OR (content_ciphertext IS NOT NULL AND content_key_id IS DISTINCT FROM $2)
            OR external_message_id IS NOT NULL
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [batchSize, activeKeyId]
      );
      for (const row of rows.rows) {
        const content = row.content ??
          (row.content_ciphertext
            ? encryption.decrypt(row.content_ciphertext, "messages.content")
            : null);
        const protectedContent = content === null
          ? null
          : encryption.encrypt(content, "messages.content");
        const externalMessageIdHash = row.external_message_id
          ? hashOpaqueIdentifier(row.external_message_id, phoneHashSecret!, "whatsapp-message-id")
          : row.external_message_id_hash;
        await client.query(
          `UPDATE messages
           SET content_ciphertext = $2, content_key_id = $3, content = NULL,
               external_message_id = NULL, external_message_id_hash = $4,
               updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            protectedContent?.ciphertext ?? null,
            protectedContent?.keyId ?? null,
            externalMessageIdHash
          ]
        );
      }
      await client.query("COMMIT");
      total += rows.rowCount ?? 0;
      if ((rows.rowCount ?? 0) < batchSize) return total;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

try {
  const users = await encryptUsers();
  const messages = await encryptMessages();
  process.stdout.write(`Protected ${users} user record(s) and ${messages} message record(s).\n`);
} finally {
  await pool.end();
}
