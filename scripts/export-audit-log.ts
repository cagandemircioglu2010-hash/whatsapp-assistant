import "dotenv/config";
import { createWriteStream } from "node:fs";
import pg from "pg";
import { assertSafePostgresUrl, databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const { Pool } = pg;

// Compliance/incident export of the tamper-evident audit log:
//
//   npm run db:export-audit                       # last 30 days, JSON lines
//   npm run db:export-audit -- --days 90 --format csv --out audit.csv
//
// Only structured metadata is exported (event types, outcomes, error codes);
// message content never reaches the audit table in the first place. Verify
// chain integrity separately with npm run db:verify-audit.

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const days = Number(argument("days") ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("--days must be 1-3650");
const format = argument("format") ?? "json";
if (format !== "json" && format !== "csv") throw new Error("--format must be json or csv");
const out = argument("out") ?? `audit-export-${new Date().toISOString().slice(0, 10)}.${format === "json" ? "jsonl" : "csv"}`;

const databaseUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
assertSafePostgresUrl(databaseUrl);

const ssl = databaseTlsFromEnvironment(process.env);
const pool = new Pool({ connectionString: databaseUrl, ssl, max: 1 });

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

try {
  const stream = createWriteStream(out, { mode: 0o600 });
  if (format === "csv") {
    stream.write("created_at,event_type,outcome,resource,user_id,message_id,details\n");
  }

  let exported = 0;
  const pageSize = 1_000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await pool.query<{
      id: string;
      user_id: string | null;
      event_type: string;
      resource: string | null;
      outcome: string;
      message_id: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id, user_id, event_type, resource, outcome, message_id, details, created_at
       FROM audit_events
       WHERE created_at > NOW() - ($1 || ' days')::interval
       ORDER BY created_at, id
       LIMIT $2 OFFSET $3`,
      [String(days), pageSize, offset]
    );
    for (const row of page.rows) {
      exported += 1;
      if (format === "json") {
        stream.write(`${JSON.stringify({ ...row, created_at: row.created_at.toISOString() })}\n`);
      } else {
        stream.write(
          [
            row.created_at.toISOString(),
            row.event_type,
            row.outcome,
            csvCell(row.resource),
            csvCell(row.user_id),
            csvCell(row.message_id),
            csvCell(JSON.stringify(row.details))
          ].join(",") + "\n"
        );
      }
    }
    if (page.rows.length < pageSize) break;
  }

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
  process.stdout.write(`Exported ${exported} audit event(s) from the last ${days} day(s) to ${out}\n`);
} finally {
  await pool.end();
}
