import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import pg from "pg";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../config/database-tls.js";
import { findMigrationsDirectory, readMigrationSql } from "./migration-files.js";

const { Pool } = pg;

const scope = process.env.MIGRATION_SCOPE ?? "all";
if (!new Set(["all", "app", "company"]).has(scope)) {
  throw new Error("MIGRATION_SCOPE must be one of: all, app, company");
}
const through = process.env.MIGRATION_THROUGH;
if (through && !/^\d{3}_[a-z0-9_]+\.sql$/.test(through)) {
  throw new Error("MIGRATION_THROUGH must be an exact migration filename");
}
const databaseUrl =
  scope === "company"
    ? process.env.COMPANY_DATABASE_ADMIN_URL
    : process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    scope === "company"
      ? "COMPANY_DATABASE_ADMIN_URL must be set"
      : "DATABASE_ADMIN_URL or DATABASE_URL must be set"
  );
}
assertSafePostgresUrl(databaseUrl);

const ssl = databaseTlsFromEnvironment(process.env, scope === "company" ? "company" : "app");
const migrationsDirectory = await findMigrationsDirectory(import.meta.url);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });
const files = (await readdir(migrationsDirectory))
  .filter((filename) => /^\d+_.+\.sql$/.test(filename))
  .filter((filename) => {
    if (scope === "app") return filename !== "002_company_reporting.sql";
    if (scope === "company") return filename === "002_company_reporting.sql";
    return true;
  })
  .filter((filename) => !through || filename <= through)
  .sort();

if (through && !files.includes(through)) {
  throw new Error(`MIGRATION_THROUGH is not in the selected migration scope: ${through}`);
}

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('company-whatsapp-assistant.migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const filename of files) {
    const sql = await readMigrationSql(migrationsDirectory, filename);
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE filename = $1",
      [filename]
    );

    if (existing.rowCount) {
      if (existing.rows[0]?.checksum !== checksum) {
        throw new Error(`Applied migration was modified: ${filename}`);
      }
      process.stdout.write(`skip ${filename}\n`);
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
        filename,
        checksum
      ]);
      await client.query("COMMIT");
      process.stdout.write(`applied ${filename}\n`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
} finally {
  await client
    .query("SELECT pg_advisory_unlock(hashtext('company-whatsapp-assistant.migrations'))")
    .catch(() => undefined);
  client.release();
  await pool.end();
}
