import type { Pool } from "pg";
import type { EnvelopeEncryption } from "../security/encryption.js";
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
};

export type SaveInboundInput = {
  externalMessageId: string;
  userId: string | null;
  content: string | null;
  senderPhoneHash: string;
  messageType: string;
  metadata?: Record<string, unknown>;
};

export type SaveOutboundInput = {
  externalMessageId?: string | null;
  userId: string;
  content: string;
  senderPhoneHash: string;
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
    private readonly encryption: EnvelopeEncryption | null
  ) {}

  private encryptContent(content: string | null): { ciphertext: string | null; keyId: string | null } {
    if (content === null) return { ciphertext: null, keyId: null };
    if (!this.encryption) throw new Error("Message encryption is not configured");
    const encrypted = this.encryption.encrypt(content, "messages.content");
    return { ciphertext: encrypted.ciphertext, keyId: encrypted.keyId };
  }

  async saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord> {
    const protectedContent = this.encryptContent(input.content);
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (
         external_message_id, user_id, direction, message_type, content,
         content_ciphertext, content_key_id, sender_phone_hash, status, metadata
       )
       VALUES ($1, $2, 'inbound', $3, NULL, $4, $5, $6, 'received', $7::jsonb)
       ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL
       DO UPDATE SET external_message_id = EXCLUDED.external_message_id
       RETURNING id, status, processing_attempts`,
      [
        input.externalMessageId,
        input.userId,
        input.messageType,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhoneHash,
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
       WHERE id = $1
         AND status IN ('received', 'failed')
         AND processing_attempts < 3
       RETURNING id`,
      [messageId]
    );
    return result.rowCount === 1;
  }

  async claimNextInbound(): Promise<PendingInboundMessage | null> {
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      content: string | null;
      content_ciphertext: string | null;
      sender_phone_hash: string;
    }>(
      `WITH candidate AS (
         SELECT id
         FROM messages
         WHERE direction = 'inbound'
           AND user_id IS NOT NULL
           AND (
             status IN ('received', 'failed')
             OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes')
           )
           AND processing_attempts < 3
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE messages AS message
       SET status = 'processing', processing_attempts = processing_attempts + 1, updated_at = NOW()
       FROM candidate
       WHERE message.id = candidate.id
       RETURNING message.id, message.user_id, message.content, message.content_ciphertext,
                 message.sender_phone_hash`,
      []
    );
    const row = result.rows[0];
    if (!row) return null;
    const content = row.content_ciphertext
      ? this.encryption?.decrypt(row.content_ciphertext, "messages.content") ?? null
      : row.content;
    return {
      id: row.id,
      userId: row.user_id,
      content,
      senderPhoneHash: row.sender_phone_hash
    };
  }

  async setInboundStatus(messageId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    await this.pool.query("UPDATE messages SET status = $2, updated_at = NOW() WHERE id = $1", [
      messageId,
      status
    ]);
  }

  async saveOutbound(input: SaveOutboundInput): Promise<string> {
    const protectedContent = this.encryptContent(input.content);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO messages (
         external_message_id, user_id, direction, message_type, content,
         content_ciphertext, content_key_id, sender_phone_hash, status, metadata
       )
       VALUES ($1, $2, 'outbound', 'text', NULL, $3, $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        input.externalMessageId ?? null,
        input.userId,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhoneHash,
        input.status,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Outbound message could not be stored");
    return id;
  }

  async reserveOutbound(input: ReserveOutboundInput): Promise<OutboundReservation> {
    const protectedContent = this.encryptContent(input.content);
    const reserved = await this.pool.query<{ id: string; status: string }>(
      `INSERT INTO messages (
         user_id, direction, message_type, content, content_ciphertext, content_key_id,
         sender_phone_hash, status, metadata, reply_to_message_id, delivery_attempts
       )
       VALUES ($1, 'outbound', 'text', NULL, $2, $3, $4, 'sending', $5::jsonb, $6, 1)
       ON CONFLICT (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL
       DO UPDATE SET
         status = 'sending',
         content_ciphertext = EXCLUDED.content_ciphertext,
         content_key_id = EXCLUDED.content_key_id,
         metadata = EXCLUDED.metadata,
         delivery_attempts = messages.delivery_attempts + 1,
         updated_at = NOW()
       WHERE messages.status = 'failed' AND messages.delivery_attempts < 3
       RETURNING id, status`,
      [
        input.userId,
        protectedContent.ciphertext,
        protectedContent.keyId,
        input.senderPhoneHash,
        JSON.stringify(input.metadata ?? {}),
        input.replyToMessageId
      ]
    );
    const newReservation = reserved.rows[0];
    if (newReservation) return { ...newReservation, shouldSend: true };

    const existing = await this.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM messages WHERE reply_to_message_id = $1 LIMIT 1",
      [input.replyToMessageId]
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Outbound reservation could not be resolved");
    return { ...row, shouldSend: false };
  }

  async markOutboundSent(messageId: string, externalMessageId: string): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE messages
       SET external_message_id = $2, status = 'sent', updated_at = NOW()
       WHERE id = $1 AND status = 'sending'
       RETURNING id`,
      [messageId, externalMessageId]
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
      `UPDATE messages
       SET status = 'delivery_unknown', updated_at = NOW()
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
       WHERE external_message_id = $1
         AND direction = 'outbound'
         AND (
           ($2 = 'sent' AND status IN ('sending', 'sent'))
           OR ($2 = 'delivered' AND status IN ('sent', 'delivered'))
           OR ($2 = 'read' AND status IN ('sent', 'delivered', 'read'))
           OR ($2 = 'failed' AND status IN ('sending', 'sent', 'failed'))
         )
       RETURNING id, user_id`,
      [externalMessageId, status]
    );
    const row = result.rows[0];
    return row ? { id: row.id, userId: row.user_id } : null;
  }

  async listRecentForUser(userId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.pool.query(
      `SELECT id, external_message_id, direction, message_type, content,
              content_ciphertext, status, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );
    return result.rows.map((row) => {
      const encrypted = typeof row.content_ciphertext === "string" ? row.content_ciphertext : null;
      const content = encrypted
        ? this.encryption?.decrypt(encrypted, "messages.content") ?? null
        : (row.content ?? null);
      const { content_ciphertext: _ciphertext, ...safeRow } = row;
      return { ...safeRow, content };
    });
  }

  async purgeExpiredContent(retentionDays: number): Promise<number> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      throw new Error("Retention days must be between 1 and 365");
    }
    const result = await this.pool.query(
      `UPDATE messages
       SET content = NULL, content_ciphertext = NULL, content_key_id = NULL, updated_at = NOW()
       WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')
         AND (content IS NOT NULL OR content_ciphertext IS NOT NULL)`,
      [retentionDays]
    );
    return result.rowCount ?? 0;
  }
}
