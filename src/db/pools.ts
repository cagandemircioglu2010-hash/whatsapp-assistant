import pg, { type Pool, type PoolClient } from "pg";
import { assertSafePostgresUrl, type DatabaseTlsConfig } from "../config/database-tls.js";

const { Pool: PgPool } = pg;

type PoolOptions = {
  tls: DatabaseTlsConfig;
  max?: number;
  applicationName: string;
  forceReadOnly?: boolean;
};

export function createDatabasePool(connectionString: string, options: PoolOptions): Pool {
  assertSafePostgresUrl(connectionString);
  const sessionOptions = [
    `-c search_path=${options.forceReadOnly ? "pg_catalog,assistant_reporting" : "pg_catalog,public"}`,
    `-c statement_timeout=${options.forceReadOnly ? 5000 : 10000}`,
    "-c lock_timeout=2000",
    "-c idle_in_transaction_session_timeout=10000",
    ...(options.forceReadOnly ? ["-c default_transaction_read_only=on"] : [])
  ].join(" ");
  return new PgPool({
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: options.tls,
    options: sessionOptions
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
