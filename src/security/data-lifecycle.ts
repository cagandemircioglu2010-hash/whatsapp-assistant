import type { Pool, PoolClient } from "pg";

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
  rateLimitBucketsDeleted: number;
  legalHold?: boolean;
};

export type ClientDataCounts = {
  users: number;
  permissions: number;
  messages: number;
  audit_events: number;
  rate_limit_buckets: number;
  encryption_canaries: number;
  audit_chain_anchors: number;
};

export async function runDataLifecycleJob(
  pool: Pool,
  policy: DataLifecyclePolicy
): Promise<DataLifecyclePurgeResult | null> {
  const result = await pool.query<{ result: DataLifecyclePurgeResult | { errorCode: string } | null }>(
    "SELECT assistant_run_data_lifecycle($1, $2, $3) AS result",
    [policy.contentDays, policy.messageRecordDays, policy.auditDays]
  );
  const value = result.rows[0]?.result ?? null;
  if (value && "errorCode" in value) throw new Error(`Data lifecycle job failed with SQLSTATE ${value.errorCode}`);
  return value;
}

export async function readClientDataCounts(client: Queryable): Promise<ClientDataCounts> {
  const result = await client.query<ClientDataCounts>(
    `SELECT
       (SELECT COUNT(*)::integer FROM users) AS users,
       (SELECT COUNT(*)::integer FROM permissions) AS permissions,
       (SELECT COUNT(*)::integer FROM messages) AS messages,
       (SELECT COUNT(*)::integer FROM audit_events) AS audit_events,
       (SELECT COUNT(*)::integer FROM rate_limit_buckets) AS rate_limit_buckets,
       (SELECT COUNT(*)::integer FROM encryption_canaries) AS encryption_canaries,
       (SELECT COUNT(*)::integer FROM audit_chain_anchors) AS audit_chain_anchors`
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
  await client.query("DELETE FROM rate_limit_buckets");
  await client.query("DELETE FROM encryption_canaries");
  await client.query("DELETE FROM audit_chain_anchors");
  await client.query("ALTER SEQUENCE audit_events_sequence_seq RESTART WITH 1");
  await client.query(
    `UPDATE audit_chain_state
     SET last_sequence = NULL, last_hash = NULL, updated_at = NOW()
     WHERE singleton = TRUE`
  );
  await client.query(
    `UPDATE maintenance_job_state
     SET last_started_at = NULL, last_succeeded_at = NULL,
         last_result = '{}'::jsonb, consecutive_failures = 0, last_error_code = NULL
     WHERE job_name = 'data-lifecycle'`
  );
  const after = await readClientDataCounts(client);
  if (Object.values(after).some((value) => value !== 0)) {
    throw new Error("Client data erasure verification failed");
  }
  return { before, after };
}

export type UserErasureResult = {
  userDeleted: boolean;
  messagesDeleted: number;
  permissionsDeleted: number;
};

export async function eraseUserData(
  client: Queryable,
  userId: string
): Promise<UserErasureResult> {
  const messages = await client.query("DELETE FROM messages WHERE user_id = $1", [userId]);
  const permissions = await client.query("DELETE FROM permissions WHERE user_id = $1", [userId]);
  const user = await client.query("DELETE FROM users WHERE id = $1", [userId]);
  return {
    userDeleted: user.rowCount === 1,
    messagesDeleted: messages.rowCount ?? 0,
    permissionsDeleted: permissions.rowCount ?? 0
  };
}
