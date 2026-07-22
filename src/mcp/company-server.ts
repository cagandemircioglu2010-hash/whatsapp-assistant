import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthorizationService, PermissionDeniedError } from "../auth/authorization.service.js";
import type { AuthorizedUser } from "../auth/types.js";
import { reportResources } from "../auth/types.js";
import type { AuditStore } from "../messages/audit.repository.js";
import type { CompanyReports } from "../reports/company-report.repository.js";
import { MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE } from "../reports/schema-policy.js";
import {
  reportingSchemaInputShape,
  reportingQueryInputShape,
  ReportingQueryError,
  type ReportingQueries
} from "../reports/schema-query.repository.js";

export { MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE } from "../reports/schema-policy.js";

export const companyToolResources = {
  get_sales_summary: reportResources.sales,
  get_active_projects: reportResources.projects,
  get_overdue_tasks: reportResources.tasks,
  describe_database: reportResources.databaseExplore,
  query_database: reportResources.databaseExplore
} as const;

export type CompanyToolName = keyof typeof companyToolResources;

type CompanyMcpServerDependencies = {
  actor: AuthorizedUser;
  actorProvider?: () => Promise<AuthorizedUser | null>;
  messageId?: string;
  reports: CompanyReports;
  reportsEnabled?: boolean;
  reportingQueries?: ReportingQueries;
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
const databaseExplorerRoles = new Set(["executive", "admin"]);

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
    operation: (actor: AuthorizedUser) => Promise<T>,
    auditOptions: {
      resource?: string;
      details?: Record<string, unknown>;
      successDetails?: (data: T) => Record<string, unknown>;
    } = {}
  ) {
    const authorizationResource = companyToolResources[toolName];
    const resource = auditOptions.resource ?? authorizationResource;
    const startedAt = performance.now();
    try {
      const actor = dependencies.actorProvider
        ? await dependencies.actorProvider()
        : dependencies.actor;
      if (!actor || actor.id !== dependencies.actor.id) {
        throw new PermissionDeniedError(authorizationResource);
      }
      await dependencies.authorization.require(actor.id, authorizationResource);
      const data = await operation(actor);
      await dependencies.audit.record({
        userId: actor.id,
        eventType: "mcp.tool_call",
        resource,
        outcome: "success",
        messageId: dependencies.messageId ?? null,
        details: {
          toolName,
          ...auditOptions.details,
          ...auditOptions.successDetails?.(data),
          durationMs: Math.max(0, Math.round(performance.now() - startedAt))
        }
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data
      };
    } catch (error) {
      const permissionDenied = error instanceof PermissionDeniedError;
      const reportingError = error instanceof ReportingQueryError;
      await dependencies.audit
        .record({
          userId: dependencies.actor.id,
          eventType: "mcp.tool_call",
          resource: permissionDenied ? error.resource : resource,
          outcome: permissionDenied ? "denied" : "failure",
          messageId: dependencies.messageId ?? null,
          details: {
            toolName,
            ...auditOptions.details,
            errorType: error instanceof Error ? error.name : "UnknownError",
            ...(reportingError ? { rejectionCode: error.code } : {}),
            durationMs: Math.max(0, Math.round(performance.now() - startedAt))
          }
        })
        .catch(() => undefined);
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

  if (dependencies.reportsEnabled !== false) server.registerTool(
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

  if (dependencies.reportsEnabled !== false) server.registerTool(
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
      runTool("get_active_projects", async (actor) => ({
        projects: (
          await dependencies.reports.getActiveProjects(
            scopedListOptions(actor, department, reportResources.projects, limit)
          )
        ).map(({ id: _id, updatedAt: _updatedAt, ...project }) => project)
      }))
  );

  if (dependencies.reportsEnabled !== false) server.registerTool(
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
      runTool("get_overdue_tasks", async (actor) => ({
        tasks: (
          await dependencies.reports.getOverdueTasks(
            scopedListOptions(actor, department, reportResources.tasks, limit)
          )
        ).map(({ id: _id, projectId: _projectId, updatedAt: _updatedAt, ...task }) => task)
      }))
  );

  if (dependencies.reportingQueries) {
    const relationPolicies = dependencies.reportingQueries.relationPolicies();
    const policyByRelation = new Map(
      relationPolicies.map((policy) => [policy.relation, policy])
    );
    const requireDatabaseExplorerRole = (actor: AuthorizedUser) => {
      if (!databaseExplorerRoles.has(actor.role.toLowerCase())) {
        throw new PermissionDeniedError(reportResources.databaseExplore);
      }
    };
    const accessibleRelations = async (actor: AuthorizedUser) => {
      const allowedResources = await dependencies.authorization.allowedResources(
        actor.id,
        relationPolicies.map((policy) => policy.resource)
      );
      return new Set(
        relationPolicies
          .filter((policy) => allowedResources.has(policy.resource))
          .map((policy) => policy.relation)
      );
    };

    server.registerTool(
      "describe_database",
      {
        title: "Veritabanı şemasını keşfet",
        description:
          `İzin verilen salt-okunur veritabanı görünümlerini ve güvenli alan adlarını sayfalar halinde listeler. İlk çağrıda cursor için null, devam sayfasında önceki sonucun nextCursor değerini kullan. Bir mesajda en fazla ${MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE} kez çağır; sonuçtaki tam schema.relation ve alan adlarını kullan.`,
        inputSchema: reportingSchemaInputShape,
        annotations: readOnlyAnnotations
      },
      async (input) =>
        runTool("describe_database", async (actor) => {
          requireDatabaseExplorerRole(actor);
          return {
            database: await dependencies.reportingQueries!.discoverSchema(
              input,
              await accessibleRelations(actor)
            )
          };
        }, {
          successDetails: (data) => ({
            relationCount: data.database.relations.length,
            hasNextPage: data.database.nextCursor !== null
          })
        })
    );

    server.registerTool(
      "query_database",
      {
        title: "Veritabanını güvenli sorgula",
        description:
          "Keşfedilmiş tek bir salt-okunur ilişkiyi yapılandırılmış filtre, toplama, sıralama ve satır sınırıyla sorgular. SQL metni, join, alt sorgu veya yazma işlemi kabul etmez. Sadece describe_database sonucundaki adları kullan ve bu aracı mesaj başına en fazla bir kez çağır.",
        inputSchema: reportingQueryInputShape,
        annotations: readOnlyAnnotations
      },
      async (input) =>
        {
          const policy = policyByRelation.get(input.relation);
          const policyColumns = new Set(policy?.columns ?? []);
          const aggregateTargets = new Map(
            input.aggregates.map((aggregate, index) => [aggregate.alias, `aggregate_${index}`])
          );
          const shape = {
            relation: policy?.relation ?? "unmapped",
            columns: input.columns.map((column) =>
              policyColumns.has(column) ? column : "unmapped"
            ),
            filters: input.filters.map((filter) => ({
              column: policyColumns.has(filter.column) ? filter.column : "unmapped",
              operator: filter.operator,
              valueCount: filter.operator === "in" ? filter.values.length : filter.value === null ? 0 : 1
            })),
            groupBy: input.group_by.map((column) =>
              policyColumns.has(column) ? column : "unmapped"
            ),
            aggregates: input.aggregates.map((aggregate, index) => ({
              position: index,
              function: aggregate.function,
              column:
                aggregate.column && policyColumns.has(aggregate.column)
                  ? aggregate.column
                  : null
            })),
            orderBy: input.order_by.map((order) => ({
              target: policyColumns.has(order.target)
                ? order.target
                : aggregateTargets.get(order.target) ?? "unmapped",
              direction: order.direction
            })),
            limit: input.limit
          };
          return runTool("query_database", async (actor) => {
            requireDatabaseExplorerRole(actor);
            if (!policy) {
              throw new ReportingQueryError("unknown_relation", "Relation is unavailable");
            }
            await dependencies.authorization.require(actor.id, policy.resource);
            return {
              result: await dependencies.reportingQueries!.query(
                input,
                new Set([policy.relation])
              )
            };
          }, {
            ...(policy ? { resource: policy.resource } : {}),
            details: {
              relation: policy?.relation ?? "unmapped",
              queryShapeHash: createHash("sha256")
                .update(JSON.stringify(shape))
                .digest("hex")
            },
            successDetails: (data) => ({
              rowCount: data.result.rowCount,
              truncated: data.result.truncated,
              selectedColumns: policy
                ? input.columns.filter((column) => policy.columns.includes(column))
                : [],
              aggregates: policy
                ? input.aggregates.map((aggregate) => ({
                    function: aggregate.function,
                    column:
                      aggregate.column && policy.columns.includes(aggregate.column)
                        ? aggregate.column
                        : null
                  }))
                : []
            })
          });
        }
    );
  }

  return server;
}
