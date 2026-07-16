import "dotenv/config";
import pg from "pg";
import format from "pg-format";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;
const adminUrl = process.env.DATABASE_ADMIN_URL;
const roleName = process.env.APP_RUNTIME_USER;
const rolePassword = process.env.APP_RUNTIME_PASSWORD;
const dedicatedDatabaseConfirmed = process.argv.includes("--confirm-dedicated-database");

if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(adminUrl);
if (!roleName || !/^[a-z][a-z0-9_]{2,62}$/.test(roleName)) {
  throw new Error("APP_RUNTIME_USER must be a safe PostgreSQL role name");
}
if (!rolePassword || rolePassword.length < 20) {
  throw new Error("APP_RUNTIME_PASSWORD must contain at least 20 characters");
}
if (!dedicatedDatabaseConfirmed) {
  throw new Error(
    "Pass --confirm-dedicated-database after verifying that PUBLIC privilege revocation will not affect other applications"
  );
}

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: adminUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  const role = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [roleName]
  );
  const database = await client.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = database.rows[0]?.name;
  if (!databaseName) throw new Error("Current database name could not be determined");

  await client.query("BEGIN");
  const roleSql = role.rows[0]?.exists ? "ALTER ROLE" : "CREATE ROLE";
  await client.query(
    format(
      `${roleSql} %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L`,
      roleName,
      rolePassword
    )
  );
  await client.query(format("ALTER ROLE %I CONNECTION LIMIT 10", roleName));
  await client.query(format("ALTER ROLE %I SET statement_timeout = '10s'", roleName));
  await client.query(format("ALTER ROLE %I SET lock_timeout = '2s'", roleName));
  await client.query(format("ALTER ROLE %I SET idle_in_transaction_session_timeout = '10s'", roleName));
  await client.query(format("ALTER ROLE %I SET search_path = pg_catalog, public", roleName));
  await client.query(format("GRANT CONNECT ON DATABASE %I TO %I", databaseName, roleName));
  // PostgreSQL privileges granted to PUBLIC cannot be denied for only one role.
  // This service uses a dedicated app database, so remove the inherited grants.
  await client.query(format("REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC", databaseName));
  await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await client.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
  await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC");
  await client.query("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC");
  await client.query("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
  await client.query(format("REVOKE CREATE ON SCHEMA public FROM %I", roleName));
  await client.query(format("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I", roleName));
  await client.query(format("GRANT USAGE ON SCHEMA public TO %I", roleName));
  await client.query(
    format(
      "GRANT SELECT ON users, permissions, service_state, maintenance_job_state, schema_migrations TO %I",
      roleName
    )
  );
  await client.query(format("GRANT SELECT, INSERT, UPDATE ON messages TO %I", roleName));
  await client.query(format("GRANT INSERT ON audit_events TO %I", roleName));
  await client.query(format("GRANT SELECT, UPDATE ON audit_chain_state TO %I", roleName));
  await client.query(format("GRANT SELECT, INSERT, UPDATE ON rate_limit_buckets TO %I", roleName));
  await client.query(format("GRANT SELECT, INSERT, UPDATE ON encryption_canaries TO %I", roleName));
  await client.query(format("GRANT USAGE, SELECT ON SEQUENCE audit_events_sequence_seq TO %I", roleName));
  await client.query(
    format(
      "GRANT EXECUTE ON FUNCTION assistant_run_data_lifecycle(INTEGER, INTEGER, INTEGER) TO %I",
      roleName
    )
  );
  await client.query("COMMIT");
  process.stdout.write(`Restricted application role ${roleName} is ready.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
