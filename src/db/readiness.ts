import type { Pool } from "pg";
import type { EnvelopeEncryption } from "../security/encryption.js";
import type { VersionedHmac } from "../security/keyed-hash.js";

export const REQUIRED_APP_MIGRATION = "006_finalize_security_controls.sql";
export const REQUIRED_COMPANY_MIGRATION = "002_company_reporting.sql";
const CANARY_NAME = "primary-encryption-canary";
const CANARY_VALUE = "company-whatsapp-assistant-encryption-canary-v1";
type Queryable = Pick<Pool, "query">;

async function migrationApplied(pool: Pool, filename: string): Promise<boolean> {
  const result = await pool.query<{ applied: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL
       AND EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS applied`,
    [filename]
  );
  return result.rows[0]?.applied === true;
}

export async function ensureSecurityCanary(
  appDatabase: Queryable,
  encryption: EnvelopeEncryption,
  identifiers: VersionedHmac,
  auditIntegrity: VersionedHmac
): Promise<void> {
  const existing = await appDatabase.query<{
    ciphertext: string;
    key_id: string;
    integrity_digest: string;
    integrity_key_id: string;
    identifier_digest: string;
    identifier_key_id: string;
  }>(
    `SELECT ciphertext, key_id, integrity_digest, integrity_key_id,
            identifier_digest, identifier_key_id
     FROM encryption_canaries WHERE name = $1`,
    [CANARY_NAME]
  );
  const binding = `encryption_canaries:${CANARY_NAME}`;
  if (existing.rows[0]) {
    const decrypted = encryption.decrypt(existing.rows[0].ciphertext, "security.canary", binding);
    if (decrypted !== CANARY_VALUE) throw new Error("Encryption canary has an unexpected value");
    if (
      !auditIntegrity.verify(
        CANARY_VALUE,
        "security-canary-integrity",
        existing.rows[0].integrity_digest,
        existing.rows[0].integrity_key_id
      )
    ) {
      throw new Error("Audit integrity canary failed authentication");
    }
    if (
      !identifiers.verify(
        CANARY_VALUE,
        "security-canary-identifier",
        existing.rows[0].identifier_digest,
        existing.rows[0].identifier_key_id
      )
    ) {
      throw new Error("Identifier HMAC canary failed authentication");
    }
  }
  if (
    !existing.rows[0] ||
    !encryption.isCurrentEnvelope(existing.rows[0].ciphertext) ||
    existing.rows[0].key_id !== encryption.activeKeyId ||
    existing.rows[0].integrity_key_id !== auditIntegrity.activeKeyId ||
    existing.rows[0].identifier_key_id !== identifiers.activeKeyId
  ) {
    const protectedValue = encryption.encrypt(CANARY_VALUE, "security.canary", binding);
    const protectedIntegrity = auditIntegrity.hash(CANARY_VALUE, "security-canary-integrity");
    const protectedIdentifier = identifiers.hash(CANARY_VALUE, "security-canary-identifier");
    await appDatabase.query(
      `INSERT INTO encryption_canaries (
         name, ciphertext, key_id, integrity_digest, integrity_key_id,
         identifier_digest, identifier_key_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (name) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext, key_id = EXCLUDED.key_id,
         integrity_digest = EXCLUDED.integrity_digest,
         integrity_key_id = EXCLUDED.integrity_key_id,
         identifier_digest = EXCLUDED.identifier_digest,
         identifier_key_id = EXCLUDED.identifier_key_id, updated_at = NOW()`,
      [
        CANARY_NAME,
        protectedValue.ciphertext,
        protectedValue.keyId,
        protectedIntegrity.hash,
        protectedIntegrity.keyId,
        protectedIdentifier.hash,
        protectedIdentifier.keyId
      ]
    );
  }
}

export async function assertRuntimeReady(
  appPool: Pool,
  companyPool: Pool,
  encryption: EnvelopeEncryption,
  identifiers: VersionedHmac,
  auditIntegrity: VersionedHmac
): Promise<void> {
  if (!(await migrationApplied(appPool, REQUIRED_APP_MIGRATION))) {
    throw new Error(`Application database migration is missing: ${REQUIRED_APP_MIGRATION}`);
  }
  const service = await appPool.query<{ decommissioned_at: Date | null }>(
    "SELECT decommissioned_at FROM service_state WHERE singleton = TRUE"
  );
  if (!service.rows[0]) throw new Error("Service state is missing");
  if (service.rows[0].decommissioned_at) {
    throw new Error("Service is decommissioned and cannot be started");
  }

  await ensureSecurityCanary(appPool, encryption, identifiers, auditIntegrity);

  const companyReady = await companyPool.query<{ ready: boolean }>(
    `SELECT to_regclass('assistant_reporting.sales_daily') IS NOT NULL
        AND to_regclass('assistant_reporting.active_projects') IS NOT NULL
        AND to_regclass('assistant_reporting.overdue_tasks') IS NOT NULL AS ready`
  );
  if (companyReady.rows[0]?.ready !== true) throw new Error("Company reporting views are unavailable");
  await Promise.all([
    companyPool.query(
      `SELECT sale_date, currency, completed_sales_count, completed_revenue,
              refund_count, refunded_amount
       FROM assistant_reporting.sales_daily WHERE FALSE`
    ),
    companyPool.query(
      `SELECT id, name, department, status, owner_name, start_date, due_date,
              updated_at, open_task_count, overdue_task_count
       FROM assistant_reporting.active_projects WHERE FALSE`
    ),
    companyPool.query(
      `SELECT id, project_id, project_name, department, title, status,
              assignee_name, priority, due_date, days_overdue, updated_at
       FROM assistant_reporting.overdue_tasks WHERE FALSE`
    )
  ]);
}

export type RuntimeHealth = {
  schemaReady: boolean;
  serviceActive: boolean;
  lifecycleHealthy: boolean;
  companyViewsReady: boolean;
  pendingMessages: number;
};

export async function readRuntimeHealth(
  appPool: Pool,
  companyPool: Pool,
  lifecycleIntervalMinutes: number
): Promise<RuntimeHealth> {
  const [app, company] = await Promise.all([
    appPool.query<{
      schema_ready: boolean;
      service_active: boolean;
      lifecycle_healthy: boolean;
      pending_messages: number;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS schema_ready,
         COALESCE((SELECT decommissioned_at IS NULL FROM service_state WHERE singleton = TRUE), FALSE)
           AS service_active,
         COALESCE((
           SELECT
             (last_succeeded_at IS NOT NULL
               AND last_succeeded_at >= NOW() - ($2::integer * INTERVAL '3 minutes'))
             OR (last_succeeded_at IS NULL
               AND created_at >= NOW() - ($2::integer * INTERVAL '2 minutes'))
           FROM maintenance_job_state
           WHERE job_name = 'data-lifecycle'
         ), FALSE) AS lifecycle_healthy,
         (SELECT COUNT(*)::integer FROM messages
          WHERE direction = 'inbound'
            AND (status IN ('received', 'processing')
              OR (status = 'failed' AND processing_attempts < 3))) AS pending_messages`,
      [REQUIRED_APP_MIGRATION, lifecycleIntervalMinutes]
    ),
    companyPool.query<{ ready: boolean }>(
      `SELECT to_regclass('assistant_reporting.sales_daily') IS NOT NULL
          AND to_regclass('assistant_reporting.active_projects') IS NOT NULL
          AND to_regclass('assistant_reporting.overdue_tasks') IS NOT NULL AS ready`
    )
  ]);
  const row = app.rows[0];
  return {
    schemaReady: row?.schema_ready === true,
    serviceActive: row?.service_active === true,
    lifecycleHealthy: row?.lifecycle_healthy === true,
    companyViewsReady: company.rows[0]?.ready === true,
    pendingMessages: Number(row?.pending_messages ?? 0)
  };
}
