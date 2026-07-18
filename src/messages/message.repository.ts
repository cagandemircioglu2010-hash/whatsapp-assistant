import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EnvelopeEncryption } from "../security/encryption.js";
import type { VersionedHash, VersionedHmac } from "../security/keyed-hash.js";
import type { WhatsAppMessageStatus } from "../whatsapp/types.js";

export type InboundMessageRecord = {
  id: string;
  status: string;
  processingAttempts: number;
};

export type PendingInboundMessage = {
  id: string;
  userId: string;
  content: string | null;
  senderPhoneHash: string;
  senderPhoneKeyId: string;
};

export type SaveInboundInput = {
  externalMessageId: string;
  userId: string;
  content: string;
  senderPhone: VersionedHash;
  messageType: string;
  metadata?: Record<string, unknown>;
};

export type SaveOutboundInput = {
  externalMessageId?: string | null;
  userId: string;
  content: string;
  senderPhone: VersionedHash;
  status: "sent" | "failed";
  metadata?: Record<string, unknown>;
};

export type ReserveOutboundInput = Omit<SaveOutboundInput, "externalMessageId" | "status"> & {
  replyToMessageId: string;
};

export type OutboundReservation = {
  id: string;
  status: string;
  shouldSend: boolean;
};

type MessageRow = {
  id: string;
  status: string;
  processing_attempts: number;
};

export interface MessageStore {
  saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord>;
  claimInbound(messageId: string): Promise<boolean>;
  setInboundStatus(messageId: string, status: "processed" | "ignored" | "failed"): Promise<void>;
  saveOutbound(input: SaveOutboundInput): Promise<string>;
}

export interface PendingMessageStore {
  claimNextInbound(): Promise<PendingInboundMessage | null>;
  markInboundUndeliverable?(messageId: string): Promise<void>;
}

export interface OutboundDeliveryStore {
  reserveOutbound(input: ReserveOutboundInput): Promise<OutboundReservation>;
  markOutboundSent(messageId: string, externalMessageId: string): Promise<void>;
  markOutboundFailed(messageId: string): Promise<void>;
  markOutboundDeliveryUnknown(messageId: string): Promise<void>;
}

export interface MessageStatusStore {
  updateOutboundStatus(
    externalMessageId: string,
    status: WhatsAppMessageStatus["status"]
  ): Promise<{ id: string; userId: string | null } | null>;
}

export class MessageRepository implements MessageStore {
  constructor(
    private readonly pool: Pool,
    private readonly encryption: EnvelopeEncryption | null,
    private readonly identifiers: VersionedHmac
  ) {}

  private externalIdentifier(externalMessageId: string): VersionedHash {
    return this.identifiers.hash(externalMessageId, "whatsapp-message-id");
  }

  private externalIdentifierCandidates(externalMessageId: string): string[] {
    return this.identifiers
      .candidates(externalMessageId, "whatsapp-message-id")
      .map((candidate) => candidate.hash);
  }

  private encryptContent(content: string, messageId: string): { ciphertext: string; keyId: string } {
    if (!this.encryption) throw new Error("Message encryption is not configured");
    const encrypted = this.encryption.encrypt(content, "messages.content", `messages:${messageId}`);
    return { ciphertext: encrypted.ciphertext, keyId: encrypted.keyId };
  }

  async saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord> {
    const existing = await this.pool.query<MessageRow>(
      `SELECT id, status, processing_attempts
       FROM messages
       WHERE external_message_id_hash::text = ANY($1::text[])
       LIMIT 1`,
      [this.externalIdentifierCandidates(input.externalMessageId)]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      return { id: row.id, status: row.status, processingAttempts: row.processing_attempts };
    }

    const id = randomUUID();
    const protectedContent = this.encryptContent(input.content, id);
    const external = this.externalIdentifier(input.externalMessageId);
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (
         id, external_message_id_hash, external_message_id_key_id, user_id, direction,
         message_type, content_ciphertext, content_key_id, sender_phone_hash,
         sender_phone_key_id, status, metadata
       ) VALUES ($1, $2, $3, $4, 'inbound', $5, $6, $7, $8, $9, 'received', $10::jsonb)
       ON CONFLICT (external_message_id_hash) WHERE external_message_id_hash IS NOT NULL
       DO UPDATE SET external_message_id_hash = EXCLUDED.external_message_id_hash
       RETURNING id, status, processing_attempts`,
      [
        id,
        external.hash,
        external.keyId,
        input.userId,
        input.messageType,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhone.hash,
        input.senderPhone.keyId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Inbound message could not be stored");
    return { id: row.id, status: row.status, processingAttempts: row.processing_attempts };
  }

  async claimInbound(messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE messages
       SET status = 'processing', processing_attempts = processing_attempts + 1, updated_at = NOW()
       WHERE id = $1 AND status IN ('received', 'failed') AND processing_attempts < 3
       RETURNING id`,
      [messageId]
    );
    return result.rowCount === 1;
  }

  async claimNextInbound(): Promise<PendingInboundMessage | null> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      content_ciphertext: string | null;
      sender_phone_hash: string;
      sender_phone_key_id: string;
    }>(
      `WITH candidate AS (
         SELECT id FROM messages
         WHERE direction = 'inbound' AND user_id IS NOT NULL
           AND (status IN ('received', 'failed')
             OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes'))
           AND processing_attempts < 3
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE messages AS message
       SET status = 'processing', processing_attempts = processing_attempts + 1, updated_at = NOW()
       FROM candidate
       WHERE message.id = candidate.id
       RETURNING message.id, message.user_id, message.content_ciphertext,
                 message.sender_phone_hash, message.sender_phone_key_id`,
      []
    );
    const row = result.rows[0];
    if (!row) return null;
    const content = row.content_ciphertext
      ? this.encryption?.decrypt(row.content_ciphertext, "messages.content", `messages:${row.id}`) ?? null
      : null;
    return {
      id: row.id,
      userId: row.user_id,
      content,
      senderPhoneHash: row.sender_phone_hash,
      senderPhoneKeyId: row.sender_phone_key_id
    };
  }

  async setInboundStatus(messageId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    await this.pool.query("UPDATE messages SET status = $2, updated_at = NOW() WHERE id = $1", [messageId, status]);
  }

  // Terminal failure: exhausting processing_attempts keeps claimNextInbound
  // and claimInbound from ever retrying a send that Meta rejects permanently.
  async markInboundUndeliverable(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE messages
       SET status = 'failed', processing_attempts = GREATEST(processing_attempts, 3), updated_at = NOW()
       WHERE id = $1`,
      [messageId]
    );
  }

  async saveOutbound(input: SaveOutboundInput): Promise<string> {
    const id = randomUUID();
    const protectedContent = this.encryptContent(input.content, id);
    const external = input.externalMessageId ? this.externalIdentifier(input.externalMessageId) : null;
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO messages (
         id, external_message_id_hash, external_message_id_key_id, user_id, direction,
         message_type, content_ciphertext, content_key_id, sender_phone_hash,
         sender_phone_key_id, status, metadata
       ) VALUES ($1, $2, $3, $4, 'outbound', 'text', $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING id`,
      [
        id,
        external?.hash ?? null,
        external?.keyId ?? null,
        input.userId,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhone.hash,
        input.senderPhone.keyId,
        input.status,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const storedId = result.rows[0]?.id;
    if (!storedId) throw new Error("Outbound message could not be stored");
    return storedId;
  }

  async reserveOutbound(input: ReserveOutboundInput): Promise<OutboundReservation> {
    const id = randomUUID();
    const protectedContent = this.encryptContent(input.content, id);
    const inserted = await this.pool.query<{ id: string; status: string }>(
      `INSERT INTO messages (
         id, user_id, direction, message_type, content_ciphertext, content_key_id,
         sender_phone_hash, sender_phone_key_id, status, metadata,
         reply_to_message_id, delivery_attempts
       ) VALUES ($1, $2, 'outbound', 'text', $3, $4, $5, $6, 'sending', $7::jsonb, $8, 1)
       ON CONFLICT (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL DO NOTHING
       RETURNING id, status`,
      [
        id,
        input.userId,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhone.hash,
        input.senderPhone.keyId,
        JSON.stringify(input.metadata ?? {}),
        input.replyToMessageId
      ]
    );
    if (inserted.rows[0]) return { ...inserted.rows[0], shouldSend: true };

    const existing = await this.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM messages WHERE reply_to_message_id = $1 LIMIT 1",
      [input.replyToMessageId]
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Outbound reservation could not be resolved");
    if (row.status === "failed") {
      const retryContent = this.encryptContent(input.content, row.id);
      const retried = await this.pool.query<{ id: string; status: string }>(
        `UPDATE messages
         SET status = 'sending', content_ciphertext = $2, content_key_id = $3,
             metadata = $4::jsonb, delivery_attempts = delivery_attempts + 1, updated_at = NOW()
         WHERE id = $1 AND status = 'failed' AND delivery_attempts < 3
         RETURNING id, status`,
        [row.id, retryContent.ciphertext, retryContent.keyId, JSON.stringify(input.metadata ?? {})]
      );
      if (retried.rows[0]) return { ...retried.rows[0], shouldSend: true };
    }
    return { ...row, shouldSend: false };
  }

  async markOutboundSent(messageId: string, externalMessageId: string): Promise<void> {
    const external = this.externalIdentifier(externalMessageId);
    const result = await this.pool.query<{ id: string }>(
      `UPDATE messages
       SET external_message_id_hash = $2, external_message_id_key_id = $3,
           status = 'sent', updated_at = NOW()
       WHERE id = $1 AND status = 'sending'
       RETURNING id`,
      [messageId, external.hash, external.keyId]
    );
    if (!result.rows[0]) throw new Error("Outbound delivery state could not be finalized");
  }

  async markOutboundFailed(messageId: string): Promise<void> {
    await this.pool.query(
      "UPDATE messages SET status = 'failed', updated_at = NOW() WHERE id = $1 AND status = 'sending'",
      [messageId]
    );
  }

  async markOutboundDeliveryUnknown(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE messages SET status = 'delivery_unknown', updated_at = NOW()
       WHERE id = $1 AND status IN ('sending', 'failed')`,
      [messageId]
    );
  }

  async updateOutboundStatus(
    externalMessageId: string,
    status: WhatsAppMessageStatus["status"]
  ): Promise<{ id: string; userId: string | null } | null> {
    const result = await this.pool.query<{ id: string; user_id: string | null }>(
      `UPDATE messages
       SET status = $2, updated_at = NOW()
       WHERE external_message_id_hash::text = ANY($1::text[])
         AND direction = 'outbound'
         AND (($2 = 'sent' AND status IN ('sending', 'delivery_unknown'))
           OR ($2 = 'delivered' AND status IN ('sending', 'delivery_unknown', 'sent'))
           OR ($2 = 'read' AND status IN ('sending', 'delivery_unknown', 'sent', 'delivered'))
           OR ($2 = 'failed' AND status IN ('sending', 'delivery_unknown', 'sent')))
       RETURNING id, user_id`,
      [this.externalIdentifierCandidates(externalMessageId), status]
    );
    const row = result.rows[0];
    return row ? { id: row.id, userId: row.user_id } : null;
  }

}
