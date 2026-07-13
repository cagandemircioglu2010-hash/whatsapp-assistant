import pg, { type Pool, type PoolClient } from "pg";

const { Pool: PgPool } = pg;

type PoolOptions = {
  ssl: boolean;
  max?: number;
  applicationName: string;
  forceReadOnly?: boolean;
};

export function createDatabasePool(connectionString: string, options: PoolOptions): Pool {
  return new PgPool({
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: options.ssl ? { rejectUnauthorized: true } : false,
    ...(options.forceReadOnly
      ? { options: "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000" }
      : {})
  });
}

export async function withReadOnlyTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
