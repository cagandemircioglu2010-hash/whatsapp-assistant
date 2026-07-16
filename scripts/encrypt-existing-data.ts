import "dotenv/config";
import pg from "pg";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { hashPhoneIdentifier } from "../src/security/phone.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const phoneHashSecret = process.env.PHONE_HASH_SECRET;
const activeKeyId = process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID;
const keysJson = process.env.DATA_ENCRYPTION_KEYS;

if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
if (!phoneHashSecret || phoneHashSecret.length < 32) throw new Error("PHONE_HASH_SECRET must be set");
if (!activeKeyId || !keysJson) throw new Error("Data encryption keys must be set");

const encryption = new EnvelopeEncryption(parseDataEncryptionConfig(keysJson, activeKeyId));
const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const batchSize = 250;

async function encryptPhones(): Promise<number> {
  let total = 0;
  while (true) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<{
        id: string;
        phone_e164: string | null;
        phone_ciphertext: string | null;
      }>(
        `SELECT id, phone_e164, phone_ciphertext
         FROM users
         WHERE phone_e164 IS NOT NULL
            OR (phone_ciphertext IS NOT NULL AND phone_key_id <> $2)
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [batchSize, activeKeyId]
      );
      for (const row of rows.rows) {
        const phone = row.phone_e164 ??
          (row.phone_ciphertext ? encryption.decrypt(row.phone_ciphertext, "users.phone") : null);
        if (!phone) throw new Error("A phone record has no decryptable representation");
        const protectedPhone = encryption.encrypt(phone, "users.phone");
        await client.query(
          `UPDATE users
           SET phone_lookup_hash = $2, phone_ciphertext = $3, phone_key_id = $4,
               phone_e164 = NULL, updated_at = NOW()
           WHERE id = $1`,
          [
            row.id,
            hashPhoneIdentifier(phone, phoneHashSecret!),
            protectedPhone.ciphertext,
            protectedPhone.keyId
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
      }>(
        `SELECT id, content, content_ciphertext
         FROM messages
         WHERE content IS NOT NULL
            OR (content_ciphertext IS NOT NULL AND content_key_id <> $2)
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
        if (content === null) throw new Error("A message record has no decryptable representation");
        const protectedContent = encryption.encrypt(content, "messages.content");
        await client.query(
          `UPDATE messages
           SET content_ciphertext = $2, content_key_id = $3, content = NULL, updated_at = NOW()
           WHERE id = $1`,
          [row.id, protectedContent.ciphertext, protectedContent.keyId]
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
  const phones = await encryptPhones();
  const messages = await encryptMessages();
  process.stdout.write(`Encrypted ${phones} phone record(s) and ${messages} message record(s).\n`);
} finally {
  await pool.end();
}
