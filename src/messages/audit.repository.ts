import type { Pool } from "pg";

export type AuditOutcome = "allowed" | "denied" | "success" | "failure" | "ignored";

export type AuditInput = {
  userId?: string | null;
  eventType: string;
  resource?: string | null;
  outcome: AuditOutcome;
  messageId?: string | null;
  details?: Record<string, unknown>;
};

export interface AuditStore {
  record(input: AuditInput): Promise<void>;
}

export class AuditRepository implements AuditStore {
  constructor(private readonly pool: Pool) {}

  async record(input: AuditInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (user_id, event_type, resource, outcome, message_id, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.userId ?? null,
        input.eventType,
        input.resource ?? null,
        input.outcome,
        input.messageId ?? null,
        JSON.stringify(input.details ?? {})
      ]
    );
  }
}
