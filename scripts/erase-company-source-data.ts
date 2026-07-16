import "dotenv/config";
import pg from "pg";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const databaseUrl = process.env.COMPANY_DATABASE_ADMIN_URL;
if (!databaseUrl) throw new Error("COMPANY_DATABASE_ADMIN_URL must be set");
assertSafePostgresUrl(databaseUrl);
const execute = process.argv.includes("--confirm-erase-company-source-data");
const clientAuthorized = process.argv.includes("--confirm-client-authorization");
const confirmedDatabase = argument("confirm-database");
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseTlsFromEnvironment(process.env, "company"),
  max: 1
});
const client = await pool.connect();

try {
  const database = await client.query<{ name: string }>("SELECT current_database() AS name");
  const databaseName = database.rows[0]?.name;
  if (!databaseName || !/^[A-Za-z0-9_.-]{1,63}$/.test(databaseName)) {
    throw new Error("Connected company database name is unavailable or unsafe");
  }
  const counts = await client.query<{ projects: number; tasks: number; sales: number }>(
    `SELECT
       (SELECT COUNT(*)::integer FROM company_source.projects) AS projects,
       (SELECT COUNT(*)::integer FROM company_source.tasks) AS tasks,
       (SELECT COUNT(*)::integer FROM company_source.sales) AS sales`
  );
  const before = counts.rows[0];
  if (!before) throw new Error("Company source counts could not be read");

  if (!execute) {
    process.stdout.write(
      `Dry run for company database ${databaseName}: ${before.projects} project(s), ` +
        `${before.tasks} task(s), and ${before.sales} sale record(s). No data was changed.\n`
    );
    process.stdout.write(
      "This deletes client-owned source data. Obtain written authorization, then provide the exact database " +
        "name with --confirm-client-authorization and --confirm-erase-company-source-data.\n"
    );
  } else {
    if (!clientAuthorized) throw new Error("--confirm-client-authorization is required");
    if (confirmedDatabase !== databaseName) {
      throw new Error("--confirm-database must exactly match the connected company database name");
    }
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '5min'");
      await client.query(
        "LOCK TABLE company_source.sales, company_source.tasks, company_source.projects IN ACCESS EXCLUSIVE MODE"
      );
      await client.query("DELETE FROM company_source.sales");
      await client.query("DELETE FROM company_source.tasks");
      await client.query("DELETE FROM company_source.projects");
      const after = await client.query<{ count: number }>(
        `SELECT
           (SELECT COUNT(*) FROM company_source.projects)
           + (SELECT COUNT(*) FROM company_source.tasks)
           + (SELECT COUNT(*) FROM company_source.sales) AS count`
      );
      if (Number(after.rows[0]?.count ?? -1) !== 0) throw new Error("Company source erasure verification failed");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    process.stdout.write(
      `Erased ${before.projects} project(s), ${before.tasks} task(s), and ${before.sales} sale record(s). ` +
        "Backups, replicas, exports, logs, and provider resources require separate verified deletion.\n"
    );
  }
} finally {
  client.release();
  await pool.end();
}
