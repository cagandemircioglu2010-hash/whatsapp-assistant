import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthorizationService, PermissionDeniedError } from "../auth/authorization.service.js";
import type { AuthorizedUser } from "../auth/types.js";
import { reportResources } from "../auth/types.js";
import type { AuditStore } from "../messages/audit.repository.js";
import type { CompanyReports } from "../reports/company-report.repository.js";

export const companyToolResources = {
  get_sales_summary: reportResources.sales,
  get_active_projects: reportResources.projects,
  get_overdue_tasks: reportResources.tasks
} as const;

export type CompanyToolName = keyof typeof companyToolResources;

type CompanyMcpServerDependencies = {
  actor: AuthorizedUser;
  messageId?: string;
  reports: CompanyReports;
  authorization: AuthorizationService;
  audit: AuditStore;
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format");
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const crossDepartmentRoles = new Set(["manager", "executive", "admin"]);

function scopedListOptions(
  actor: AuthorizedUser,
  requestedDepartment: string | null,
  resource: string,
  limit: number | null
): { limit: number; department?: string } {
  if (crossDepartmentRoles.has(actor.role.toLowerCase())) {
    return { limit: limit ?? 10, ...(requestedDepartment ? { department: requestedDepartment } : {}) };
  }
  if (!actor.department) throw new PermissionDeniedError(resource);
  return { limit: limit ?? 10, department: actor.department };
}

export function createCompanyMcpServer(dependencies: CompanyMcpServerDependencies): McpServer {
  const server = new McpServer({ name: "company-reporting", version: "0.2.0" });

  async function runTool<T extends Record<string, unknown>>(
    toolName: CompanyToolName,
    operation: () => Promise<T>
  ) {
    const resource = companyToolResources[toolName];
    try {
      await dependencies.authorization.require(dependencies.actor.id, resource);
      const data = await operation();
      await dependencies.audit.record({
        userId: dependencies.actor.id,
        eventType: "mcp.tool_call",
        resource,
        outcome: "success",
        messageId: dependencies.messageId ?? null,
        details: { toolName }
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data
      };
    } catch (error) {
      const permissionDenied = error instanceof PermissionDeniedError;
      await dependencies.audit.record({
        userId: dependencies.actor.id,
        eventType: "mcp.tool_call",
        resource,
        outcome: permissionDenied ? "denied" : "failure",
        messageId: dependencies.messageId ?? null,
        details: {
          toolName,
          errorType: error instanceof Error ? error.name : "UnknownError"
        }
      });
      const safeError = {
        code: permissionDenied ? "permission_denied" : "tool_failed",
        message: permissionDenied
          ? "Bu bilgiye erişim yetkiniz bulunmuyor."
          : "Şirket verisi şu anda alınamadı."
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(safeError) }],
        structuredContent: safeError,
        isError: true
      };
    }
  }

  server.registerTool(
    "get_sales_summary",
    {
      title: "Satış özeti",
      description:
        "Belirtilen tarih aralığındaki tamamlanan satış ve iade toplamlarını para birimine göre getirir.",
      inputSchema: {
        start_date: dateSchema.describe("Başlangıç tarihi, YYYY-MM-DD"),
        end_date: dateSchema.describe("Bitiş tarihi, YYYY-MM-DD")
      },
      annotations: readOnlyAnnotations
    },
    async ({ start_date, end_date }) =>
      runTool("get_sales_summary", async () => ({
        summary: await dependencies.reports.getSalesSummary({ startDate: start_date, endDate: end_date })
      }))
  );

  server.registerTool(
    "get_active_projects",
    {
      title: "Aktif projeler",
      description:
        "Planlanan, devam eden veya engellenmiş projeleri açık ve gecikmiş görev sayılarıyla getirir.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).nullable().describe("En fazla dönecek proje sayısı; varsayılan 10"),
        department: z.string().min(1).max(100).nullable().describe("Departman filtresi veya null")
      },
      annotations: readOnlyAnnotations
    },
    async ({ limit, department }) =>
      runTool("get_active_projects", async () => ({
        projects: (
          await dependencies.reports.getActiveProjects(
            scopedListOptions(dependencies.actor, department, reportResources.projects, limit)
          )
        ).map(({ id: _id, updatedAt: _updatedAt, ...project }) => project)
      }))
  );

  server.registerTool(
    "get_overdue_tasks",
    {
      title: "Geciken görevler",
      description:
        "Son tarihi geçmiş açık görevleri öncelik ve gecikme süresiyle getirir.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).nullable().describe("En fazla dönecek görev sayısı; varsayılan 10"),
        department: z.string().min(1).max(100).nullable().describe("Departman filtresi veya null")
      },
      annotations: readOnlyAnnotations
    },
    async ({ limit, department }) =>
      runTool("get_overdue_tasks", async () => ({
        tasks: (
          await dependencies.reports.getOverdueTasks(
            scopedListOptions(dependencies.actor, department, reportResources.tasks, limit)
          )
        ).map(({ id: _id, projectId: _projectId, updatedAt: _updatedAt, ...task }) => task)
      }))
  );

  return server;
}
