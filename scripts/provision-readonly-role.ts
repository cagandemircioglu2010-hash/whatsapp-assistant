import "dotenv/config";
import pg from "pg";
import format from "pg-format";

const { Pool } = pg;

const adminUrl = process.env.COMPANY_DATABASE_ADMIN_URL ?? process.env.DATABASE_ADMIN_URL;
const roleName = process.env.COMPANY_READONLY_USER;
const rolePassword = process.env.COMPANY_READONLY_PASSWORD;

if (!adminUrl) throw new Error("COMPANY_DATABASE_ADMIN_URL or DATABASE_ADMIN_URL must be set");
if (!roleName || !/^[a-z][a-z0-9_]{2,62}$/.test(roleName)) {
  throw new Error("COMPANY_READONLY_USER must be a safe PostgreSQL role name");
}
if (!rolePassword || rolePassword.length < 20) {
  throw new Error("COMPANY_READONLY_PASSWORD must contain at least 20 characters");
}

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
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
  if (role.rows[0]?.exists) {
    await client.query(
      format(
        "ALTER ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
        roleName,
        rolePassword
      )
    );
  } else {
    await client.query(
      format(
        "CREATE ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L",
        roleName,
        rolePassword
      )
    );
  }

  await client.query(format("ALTER ROLE %I CONNECTION LIMIT 5", roleName));
  await client.query(format("ALTER ROLE %I SET default_transaction_read_only = on", roleName));
  await client.query(format("ALTER ROLE %I SET statement_timeout = '5s'", roleName));
  await client.query(format("ALTER ROLE %I SET lock_timeout = '2s'", roleName));
  await client.query(format("GRANT CONNECT ON DATABASE %I TO %I", databaseName, roleName));

  await client.query(format("REVOKE ALL ON SCHEMA company_source FROM %I", roleName));
  await client.query(format("REVOKE ALL ON ALL TABLES IN SCHEMA company_source FROM %I", roleName));
  await client.query(format("GRANT USAGE ON SCHEMA assistant_reporting TO %I", roleName));
  await client.query(
    format(
      `GRANT SELECT ON
         assistant_reporting.sales_daily,
         assistant_reporting.active_projects,
         assistant_reporting.overdue_tasks
       TO %I`,
      roleName
    )
  );
  await client.query("COMMIT");
  process.stdout.write(`Read-only role ${roleName} is ready.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
