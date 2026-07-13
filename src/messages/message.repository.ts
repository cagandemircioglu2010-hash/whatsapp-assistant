import type { Pool } from "pg";

export type InboundMessageRecord = {
  id: string;
  status: string;
  processingAttempts: number;
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

export class MessageRepository implements MessageStore {
  constructor(private readonly pool: Pool) {}

  async saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord> {
    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (
         external_message_id, user_id, direction, message_type, content,
         sender_phone_hash, status, metadata
       )
       VALUES ($1, $2, 'inbound', $3, $4, $5, 'received', $6::jsonb)
       ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL
       DO UPDATE SET external_message_id = EXCLUDED.external_message_id
       RETURNING id, status, processing_attempts`,
      [
        input.externalMessageId,
        input.userId,
        input.messageType,
        input.content,
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

  async setInboundStatus(messageId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    await this.pool.query("UPDATE messages SET status = $2, updated_at = NOW() WHERE id = $1", [
      messageId,
      status
    ]);
  }

  async saveOutbound(input: SaveOutboundInput): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO messages (
         external_message_id, user_id, direction, message_type, content,
         sender_phone_hash, status, metadata
       )
       VALUES ($1, $2, 'outbound', 'text', $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        input.externalMessageId ?? null,
        input.userId,
        input.content,
        input.senderPhoneHash,
        input.status,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Outbound message could not be stored");
    return id;
  }

  async listRecentForUser(userId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.pool.query(
      `SELECT id, external_message_id, direction, message_type, content, status, created_at
       FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, safeLimit]
    );
    return result.rows;
  }
}
