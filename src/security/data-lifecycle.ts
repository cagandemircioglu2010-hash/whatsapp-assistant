import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export type DataLifecyclePolicy = {
  contentDays: number;
  messageRecordDays: number;
  auditDays: number;
};

export type DataLifecyclePurgeResult = {
  contentMinimized: number;
  messagesDeleted: number;
  auditEventsDeleted: number;
};

export type ClientDataCounts = {
  users: number;
  permissions: number;
  messages: number;
  audit_events: number;
};

function validDays(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export async function purgeExpiredData(
  client: Queryable,
  policy: DataLifecyclePolicy
): Promise<DataLifecyclePurgeResult> {
  if (!validDays(policy.contentDays, 365)) {
    throw new Error("Content retention must be between 1 and 365 days");
  }
  if (!validDays(policy.messageRecordDays, 3650)) {
    throw new Error("Message record retention must be between 1 and 3650 days");
  }
  if (!validDays(policy.auditDays, 3650)) {
    throw new Error("Audit retention must be between 1 and 3650 days");
  }
  if (policy.messageRecordDays < policy.contentDays) {
    throw new Error("Message record retention cannot be shorter than content retention");
  }

  const content = await client.query(
    `UPDATE messages
     SET content = NULL, content_ciphertext = NULL, content_key_id = NULL,
         metadata = '{}'::jsonb, updated_at = NOW()
     WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')
       AND (
         content IS NOT NULL
         OR content_ciphertext IS NOT NULL
         OR metadata <> '{}'::jsonb
       )`,
    [policy.contentDays]
  );

  const audit = await client.query(
    `DELETE FROM audit_events
     WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')`,
    [policy.auditDays]
  );

  const messages = await client.query(
    `DELETE FROM messages
     WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')
       AND (
         (
           direction = 'inbound'
           AND (
             status IN ('processed', 'ignored')
             OR (status = 'failed' AND processing_attempts >= 3)
           )
         )
         OR (
           direction = 'outbound'
           AND (
             status IN ('sent', 'delivery_unknown', 'delivered', 'read')
             OR (status = 'failed' AND delivery_attempts >= 3)
           )
         )
       )`,
    [policy.messageRecordDays]
  );

  return {
    contentMinimized: content.rowCount ?? 0,
    messagesDeleted: messages.rowCount ?? 0,
    auditEventsDeleted: audit.rowCount ?? 0
  };
}

export async function readClientDataCounts(client: Queryable): Promise<ClientDataCounts> {
  const result = await client.query<ClientDataCounts>(
    `SELECT
       (SELECT COUNT(*)::integer FROM users) AS users,
       (SELECT COUNT(*)::integer FROM permissions) AS permissions,
       (SELECT COUNT(*)::integer FROM messages) AS messages,
       (SELECT COUNT(*)::integer FROM audit_events) AS audit_events`
  );
  const row = result.rows[0];
  if (!row) throw new Error("Client data counts could not be read");
  return row;
}

export async function eraseAssistantData(
  client: Queryable
): Promise<{ before: ClientDataCounts; after: ClientDataCounts }> {
  const before = await readClientDataCounts(client);
  await client.query("DELETE FROM audit_events");
  await client.query("DELETE FROM messages");
  await client.query("DELETE FROM permissions");
  await client.query("DELETE FROM users");
  const after = await readClientDataCounts(client);
  if (Object.values(after).some((value) => value !== 0)) {
    throw new Error("Client data erasure verification failed");
  }
  return { before, after };
}
