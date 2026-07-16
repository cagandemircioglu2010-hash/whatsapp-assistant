import "dotenv/config";
import pg from "pg";
import { VersionedHmac } from "../src/security/keyed-hash.js";
import {
  canonicalAuditAnchor,
  canonicalAuditPayload,
  type AuditOutcome,
  type CanonicalAuditEvent
} from "../src/messages/audit.repository.js";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";
import { loadAdminSecurityConfig } from "./security-config.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
const security = loadAdminSecurityConfig();
const integrity = new VersionedHmac(security.auditIntegrity);
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseTlsFromEnvironment(process.env),
  max: 1
});

try {
  const anchor = await pool.query<{
    through_sequence: string;
    event_hash: string;
    anchor_hash: string;
    integrity_key_id: string;
  }>(
    `SELECT through_sequence::text, event_hash, anchor_hash, integrity_key_id
     FROM audit_chain_anchors ORDER BY through_sequence DESC LIMIT 1`
  );
  if (
    anchor.rows[0] &&
    !integrity.verify(
      canonicalAuditAnchor(anchor.rows[0].through_sequence, anchor.rows[0].event_hash),
      "audit-anchor",
      anchor.rows[0].anchor_hash,
      anchor.rows[0].integrity_key_id
    )
  ) {
    throw new Error("Audit retention anchor failed authentication");
  }
  const startingSequence = anchor.rows[0]?.through_sequence ?? "0";
  let previousHash = anchor.rows[0]?.event_hash ?? null;
  const events = await pool.query<{
    id: string;
    sequence: string;
    previous_hash: string | null;
    event_hash: string;
    integrity_key_id: string;
    user_reference: string | null;
    event_type: string;
    resource: string | null;
    outcome: AuditOutcome;
    message_reference: string | null;
    details: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT id, sequence::text, previous_hash, event_hash, integrity_key_id,
            user_reference, event_type, resource, outcome, message_reference,
            details, created_at
     FROM audit_events WHERE sequence > $1::bigint ORDER BY sequence`,
    [startingSequence]
  );

  for (const row of events.rows) {
    if (row.previous_hash !== previousHash) {
      throw new Error(`Audit chain link mismatch at sequence ${row.sequence}`);
    }
    const event: CanonicalAuditEvent = {
      id: row.id,
      sequence: row.sequence,
      previousHash: row.previous_hash,
      userReference: row.user_reference,
      eventType: row.event_type,
      resource: row.resource,
      outcome: row.outcome,
      messageReference: row.message_reference,
      details: row.details,
      createdAt: row.created_at.toISOString()
    };
    if (!integrity.verify(canonicalAuditPayload(event), "audit-event", row.event_hash, row.integrity_key_id)) {
      throw new Error(`Audit event authentication failed at sequence ${row.sequence}`);
    }
    previousHash = row.event_hash;
  }

  const state = await pool.query<{ last_sequence: string | null; last_hash: string | null }>(
    "SELECT last_sequence::text, last_hash FROM audit_chain_state WHERE singleton = TRUE"
  );
  const expectedSequence = events.rows.at(-1)?.sequence ?? anchor.rows[0]?.through_sequence ?? null;
  if (state.rows[0]?.last_sequence !== expectedSequence || state.rows[0]?.last_hash !== previousHash) {
    throw new Error("Audit chain state does not match the verified tail");
  }
  process.stdout.write(
    `Verified ${events.rowCount ?? 0} audit event(s) after sequence ${startingSequence}. ` +
      `Checkpoint sequence: ${expectedSequence ?? "empty"}; hash: ${previousHash ?? "empty"}.\n`
  );
} finally {
  await pool.end();
}
