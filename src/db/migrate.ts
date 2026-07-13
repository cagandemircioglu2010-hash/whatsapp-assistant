import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const scope = process.env.MIGRATION_SCOPE ?? "all";
if (!new Set(["all", "app", "company"]).has(scope)) {
  throw new Error("MIGRATION_SCOPE must be one of: all, app, company");
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

const ssl = process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false;
const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

const files = (await readdir(migrationsDirectory))
  .filter((filename) => /^\d+_.+\.sql$/.test(filename))
  .filter((filename) => {
    if (scope === "app") return filename === "001_identity_messages.sql";
    if (scope === "company") return filename === "002_company_reporting.sql";
    return true;
  })
  .sort();

for (const filename of files) {
  const sql = await readFile(new URL(`../../migrations/${filename}`, import.meta.url), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const existing = await pool.query<{ checksum: string }>(
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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
      filename,
      checksum
    ]);
    await client.query("COMMIT");
    process.stdout.write(`applied ${filename}\n`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await pool.end();
