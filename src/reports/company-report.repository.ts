import type { Pool } from "pg";
import { z } from "zod";
import { withReadOnlyTransaction } from "../db/pools.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Date is not a real calendar day");

const dateRangeSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate
  })
  .refine(({ startDate, endDate }) => startDate <= endDate, "startDate must be before or equal to endDate")
  .refine(({ startDate, endDate }) => {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    return (end - start) / 86_400_000 <= 366;
  }, "Date range cannot exceed 366 days");

const listOptionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  department: z.string().trim().min(1).max(100).optional()
});

export type SalesSummary = {
  startDate: string;
  endDate: string;
  currencies: Array<{
    currency: string;
    completedSalesCount: number;
    completedRevenue: string;
    refundCount: number;
    refundedAmount: string;
  }>;
  generatedAt: string;
};

export type ActiveProject = {
  id: string;
  name: string;
  department: string;
  status: string;
  ownerName: string | null;
  startDate: string | null;
  dueDate: string | null;
  openTaskCount: number;
  overdueTaskCount: number;
  updatedAt: string;
};

export type OverdueTask = {
  id: string;
  projectId: string;
  projectName: string;
  department: string;
  title: string;
  status: string;
  assigneeName: string | null;
  priority: string;
  dueDate: string;
  daysOverdue: number;
  updatedAt: string;
};

export interface CompanyReports {
  getSalesSummary(input: { startDate: string; endDate: string }): Promise<SalesSummary>;
  getActiveProjects(input?: { limit?: number; department?: string }): Promise<ActiveProject[]>;
  getOverdueTasks(input?: { limit?: number; department?: string }): Promise<OverdueTask[]>;
}

export class CompanyReportRepository implements CompanyReports {
  constructor(private readonly readonlyPool: Pool) {}

  async getSalesSummary(input: { startDate: string; endDate: string }): Promise<SalesSummary> {
    const range = dateRangeSchema.parse(input);
    const rows = await withReadOnlyTransaction(this.readonlyPool, async (client) => {
      const result = await client.query<{
        currency: string;
        completed_sales_count: number;
        completed_revenue: string;
        refund_count: number;
        refunded_amount: string;
      }>(
        `SELECT
           currency,
           COALESCE(SUM(completed_sales_count), 0)::integer AS completed_sales_count,
           COALESCE(SUM(completed_revenue), 0)::numeric(14, 2)::text AS completed_revenue,
           COALESCE(SUM(refund_count), 0)::integer AS refund_count,
           COALESCE(SUM(refunded_amount), 0)::numeric(14, 2)::text AS refunded_amount
         FROM assistant_reporting.sales_daily
         WHERE sale_date BETWEEN $1::date AND $2::date
         GROUP BY currency
         ORDER BY currency`,
        [range.startDate, range.endDate]
      );
      return result.rows;
    });

    return {
      startDate: range.startDate,
      endDate: range.endDate,
      currencies: rows.map((row) => ({
        currency: row.currency.trim(),
        completedSalesCount: Number(row.completed_sales_count),
        completedRevenue: row.completed_revenue,
        refundCount: Number(row.refund_count),
        refundedAmount: row.refunded_amount
      })),
      generatedAt: new Date().toISOString()
    };
  }

  async getActiveProjects(input: { limit?: number; department?: string } = {}): Promise<ActiveProject[]> {
    const options = listOptionsSchema.parse(input);
    return withReadOnlyTransaction(this.readonlyPool, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        department: string;
        status: string;
        owner_name: string | null;
        start_date: string | null;
        due_date: string | null;
        open_task_count: number;
        overdue_task_count: number;
        updated_at: Date;
      }>(
        `SELECT id, LEFT(name, 200) AS name, LEFT(department, 100) AS department,
                LEFT(status, 32) AS status, LEFT(owner_name, 120) AS owner_name,
                start_date, due_date,
                open_task_count, overdue_task_count, updated_at
         FROM assistant_reporting.active_projects
         WHERE ($1::text IS NULL OR department = $1)
         ORDER BY
           CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
           due_date ASC NULLS LAST,
           updated_at DESC
         LIMIT $2`,
        [options.department ?? null, options.limit]
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        department: row.department,
        status: row.status,
        ownerName: row.owner_name,
        startDate: row.start_date,
        dueDate: row.due_date,
        openTaskCount: Number(row.open_task_count),
        overdueTaskCount: Number(row.overdue_task_count),
        updatedAt: row.updated_at.toISOString()
      }));
    });
  }

  async getOverdueTasks(input: { limit?: number; department?: string } = {}): Promise<OverdueTask[]> {
    const options = listOptionsSchema.parse(input);
    return withReadOnlyTransaction(this.readonlyPool, async (client) => {
      const result = await client.query<{
        id: string;
        project_id: string;
        project_name: string;
        department: string;
        title: string;
        status: string;
        assignee_name: string | null;
        priority: string;
        due_date: string;
        days_overdue: number;
        updated_at: Date;
      }>(
        `SELECT id, project_id, LEFT(project_name, 200) AS project_name,
                LEFT(department, 100) AS department, LEFT(title, 200) AS title,
                LEFT(status, 32) AS status, LEFT(assignee_name, 120) AS assignee_name,
                LEFT(priority, 32) AS priority, due_date, days_overdue, updated_at
         FROM assistant_reporting.overdue_tasks
         WHERE ($1::text IS NULL OR department = $1)
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           days_overdue DESC
         LIMIT $2`,
        [options.department ?? null, options.limit]
      );
      return result.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        department: row.department,
        title: row.title,
        status: row.status,
        assigneeName: row.assignee_name,
        priority: row.priority,
        dueDate: row.due_date,
        daysOverdue: Number(row.days_overdue),
        updatedAt: row.updated_at.toISOString()
      }));
    });
  }
}
