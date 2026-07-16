import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { VersionedHmac } from "../security/keyed-hash.js";

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

export type CanonicalAuditEvent = {
  id: string;
  sequence: string;
  previousHash: string | null;
  userReference: string | null;
  eventType: string;
  resource: string | null;
  outcome: AuditOutcome;
  messageReference: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

const AUDIT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{2,99}$/;
const MAX_AUDIT_DETAILS_BYTES = 16_384;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audit details contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Audit details contain an unsupported value");
}

export function canonicalAuditPayload(event: CanonicalAuditEvent): string {
  return canonicalJson(event);
}

export function canonicalAuditAnchor(sequence: string, eventHash: string): string {
  return canonicalJson({ sequence, eventHash });
}

export async function appendAuditEvent(
  client: Pick<PoolClient, "query">,
  integrity: VersionedHmac,
  input: AuditInput
): Promise<void> {
  if (!AUDIT_NAME_PATTERN.test(input.eventType)) throw new Error("Audit event type is invalid");
  if (input.resource && !AUDIT_NAME_PATTERN.test(input.resource)) {
    throw new Error("Audit resource is invalid");
  }
  const serializedDetails = JSON.stringify(input.details ?? {});
  if (Buffer.byteLength(serializedDetails, "utf8") > MAX_AUDIT_DETAILS_BYTES) {
    throw new Error("Audit details are too large");
  }
  const details = JSON.parse(serializedDetails) as Record<string, unknown>;
  const state = await client.query<{ last_hash: string | null }>(
    "SELECT last_hash FROM audit_chain_state WHERE singleton = TRUE FOR UPDATE"
  );
  if (!state.rows[0]) throw new Error("Audit chain state is missing");
  const sequence = await client.query<{ sequence: string }>(
    "SELECT nextval('audit_events_sequence_seq')::text AS sequence"
  );
  const timestamp = await client.query<{ created_at: Date }>(
    "SELECT clock_timestamp() AS created_at"
  );
  const sequenceValue = sequence.rows[0]?.sequence;
  if (!sequenceValue) throw new Error("Audit sequence could not be reserved");
  const createdAt = timestamp.rows[0]?.created_at;
  if (!createdAt) throw new Error("Audit timestamp could not be read");
  const event: CanonicalAuditEvent = {
    id: randomUUID(),
    sequence: sequenceValue,
    previousHash: state.rows[0]?.last_hash ?? null,
    userReference: input.userId
      ? integrity.hash(input.userId, "audit-user-reference").hash
      : null,
    eventType: input.eventType,
    resource: input.resource ?? null,
    outcome: input.outcome,
    messageReference: input.messageId
      ? integrity.hash(input.messageId, "audit-message-reference").hash
      : null,
    details,
    createdAt: createdAt.toISOString()
  };
  const protectedHash = integrity.hash(canonicalAuditPayload(event), "audit-event");
  const protectedAnchor = integrity.hash(
    canonicalAuditAnchor(event.sequence, protectedHash.hash),
    "audit-anchor"
  );
  await client.query(
    `INSERT INTO audit_events (
       id, sequence, previous_hash, event_hash, anchor_hash, integrity_key_id,
       user_id, user_reference, event_type, resource, outcome,
       message_id, message_reference, details, created_at
     ) VALUES (
       $1, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz
     )`,
    [
      event.id,
      event.sequence,
      event.previousHash,
      protectedHash.hash,
      protectedAnchor.hash,
      protectedHash.keyId,
      input.userId ?? null,
      event.userReference,
      event.eventType,
      event.resource,
      event.outcome,
      input.messageId ?? null,
      event.messageReference,
      serializedDetails,
      event.createdAt
    ]
  );
  await client.query(
    `UPDATE audit_chain_state
     SET last_sequence = $1::bigint, last_hash = $2, updated_at = NOW()
     WHERE singleton = TRUE`,
    [event.sequence, protectedHash.hash]
  );
}

export class AuditRepository implements AuditStore {
  constructor(
    private readonly pool: Pool,
    private readonly integrity: VersionedHmac
  ) {}

  async record(input: AuditInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await appendAuditEvent(client, this.integrity, input);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
