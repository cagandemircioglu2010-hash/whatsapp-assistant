import "dotenv/config";
import { CompanyReportRepository } from "../src/reports/company-report.repository.js";
import { createDatabasePool } from "../src/db/pools.js";

const connectionString = process.env.COMPANY_READONLY_DATABASE_URL;
if (!connectionString) throw new Error("COMPANY_READONLY_DATABASE_URL must be set");
const pool = createDatabasePool(connectionString, {
  ssl: process.env.DATABASE_SSL === "true",
  max: 1,
  applicationName: "company-assistant-smoke-test",
  forceReadOnly: true
});
const reports = new CompanyReportRepository(pool);
const endDate = new Date().toISOString().slice(0, 10);
const startDate = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

const [sales, projects, tasks] = await Promise.all([
  reports.getSalesSummary({ startDate, endDate }),
  reports.getActiveProjects({ limit: 10 }),
  reports.getOverdueTasks({ limit: 10 })
]);

process.stdout.write(`${JSON.stringify({ sales, projects, tasks }, null, 2)}\n`);
await pool.end();
