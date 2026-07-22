import { describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/auth/authorization.service.js";
import type { PermissionLookup } from "../src/auth/permission.repository.js";
import type { AuditInput, AuditStore } from "../src/messages/audit.repository.js";
import { CompanyMcpSessionFactory } from "../src/mcp/session.js";
import type { CompanyReports } from "../src/reports/company-report.repository.js";
import type {
  ReportingQueries,
  ReportingQueryInput,
  ReportingSchemaInput
} from "../src/reports/schema-query.repository.js";

class MemoryAudit implements AuditStore {
  events: AuditInput[] = [];
  async record(input: AuditInput): Promise<void> {
    this.events.push(input);
  }
}

const reports: CompanyReports = {
  getSalesSummary: async ({ startDate, endDate }) => ({
    startDate,
    endDate,
    currencies: [
      {
        currency: "TRY",
        completedSalesCount: 5,
        completedRevenue: "25000.00",
        refundCount: 1,
        refundedAmount: "500.00"
      }
    ],
    generatedAt: "2026-07-13T17:00:00.000Z"
  }),
  getActiveProjects: async () => [],
  getOverdueTasks: async () => []
};

class MemoryReportingQueries implements ReportingQueries {
  discoveryCalls: ReportingSchemaInput[] = [];
  queryCalls: ReportingQueryInput[] = [];

  relationPolicies() {
    return [
      {
        relation: "assistant_reporting.active_projects",
        columns: ["name"],
        filterColumns: [],
        resource: "company.projects",
        allowUnfiltered: true
      }
    ];
  }

  async isReady() {
    return true;
  }

  async discoverSchema(
    input: ReportingSchemaInput = { cursor: null },
    allowedRelations = new Set(["assistant_reporting.active_projects"])
  ) {
    this.discoveryCalls.push(input);
    return {
      schemas: ["assistant_reporting"],
      relations: allowedRelations.has("assistant_reporting.active_projects")
        ? [
            {
              name: "assistant_reporting.active_projects",
              kind: "view" as const,
              columns: [{ name: "name", dataType: "text", nullable: false }],
              queryPolicy: {
                requiresFilter: false,
                filterColumns: [],
                approvedOperators: []
              }
            }
          ]
        : [],
      limits: { maxRows: 50, joinsSupported: false as const, rawSqlAccepted: false as const },
      truncated: false,
      nextCursor: null
    };
  }

  async query(input: ReportingQueryInput, allowedRelations = new Set([input.relation])) {
    if (!allowedRelations.has(input.relation)) throw new Error("relation denied");
    this.queryCalls.push(input);
    return {
      relation: input.relation,
      columns: input.columns,
      rows: [{ name: "CRM Geçişi" }],
      rowCount: 1,
      truncated: false
    };
  }
}

describe("company MCP server", () => {
  it("lists tools without exposing actor identity and enforces permissions in the server", async () => {
    const permissions: PermissionLookup = {
      has: async (_userId, resource) => resource === "company.sales"
    };
    const audit = new MemoryAudit();
    const factory = new CompanyMcpSessionFactory({
      reports,
      authorization: new AuthorizationService(permissions),
      audit
    });
    const session = await factory.open(
      { id: "secret-actor-id", department: "Sales", role: "employee" },
      { messageId: "message-1" }
    );

    try {
      const tools = await session.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["get_sales_summary"]);
      expect(JSON.stringify(tools)).not.toContain("secret-actor-id");
      const salesTool = tools.find((tool) => tool.name === "get_sales_summary");
      expect(salesTool?.inputSchema).toMatchObject({
        type: "object",
        required: ["start_date", "end_date"],
        additionalProperties: false
      });

      const sales = await session.callTool("get_sales_summary", {
        start_date: "2026-07-07",
        end_date: "2026-07-13"
      });
      expect(sales.isError).not.toBe(true);
      expect(sales.structuredContent?.summary).toMatchObject({
        startDate: "2026-07-07",
        endDate: "2026-07-13"
      });

      const denied = await session.callTool("get_overdue_tasks", { limit: 10, department: null });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ code: "permission_denied" });
      expect(audit.events.map((event) => event.outcome)).toEqual(["success", "denied"]);
      expect(audit.events.every((event) => event.messageId === "message-1")).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("rejects malformed arguments before the report repository is called", async () => {
    const permissions: PermissionLookup = { has: async () => true };
    const session = await new CompanyMcpSessionFactory({
      reports,
      authorization: new AuthorizationService(permissions),
      audit: new MemoryAudit()
    }).open(
      { id: "user-1", department: null, role: "employee" },
      { messageId: "message-2" }
    );
    try {
      const invalid = await session.callTool("get_sales_summary", {
        start_date: "13/07/2026",
        end_date: "2026-07-13"
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("exposes schema tools only to explicitly permitted admins and does not exhaust a long-lived session", async () => {
    const reportingQueries = new MemoryReportingQueries();
    const permissions: PermissionLookup = {
      has: async (_userId, resource) =>
        resource === "company.database.explore" || resource === "company.projects"
    };
    const audit = new MemoryAudit();
    const factory = new CompanyMcpSessionFactory({
      reports,
      reportsEnabled: false,
      reportingQueries,
      authorization: new AuthorizationService(permissions),
      audit
    });
    const session = await factory.open(
      { id: "admin-user", department: null, role: "admin" },
      { messageId: "message-schema" }
    );
    try {
      expect((await session.listTools()).map((tool) => tool.name)).toEqual([
        "describe_database",
        "query_database"
      ]);
      const schemaTool = (await session.listTools()).find((tool) => tool.name === "describe_database");
      expect(schemaTool?.inputSchema).toMatchObject({
        required: ["cursor"],
        additionalProperties: false
      });
      const schema = await session.callTool("describe_database", { cursor: null });
      expect(schema.structuredContent?.database).toMatchObject({
        schemas: ["assistant_reporting"]
      });
      const repeatedSchema = await session.callTool("describe_database", { cursor: null });
      expect(repeatedSchema.isError).not.toBe(true);
      expect(reportingQueries.discoveryCalls).toEqual([{ cursor: null }, { cursor: null }]);
      const queryInput: ReportingQueryInput = {
        relation: "assistant_reporting.active_projects",
        columns: ["name"],
        filters: [],
        group_by: [],
        aggregates: [],
        order_by: [],
        limit: 10
      };
      const query = await session.callTool("query_database", queryInput);
      expect(query.structuredContent?.result).toMatchObject({
        rows: [{ name: "CRM Geçişi" }]
      });
      expect(reportingQueries.queryCalls).toEqual([queryInput]);

      const repeated = await session.callTool("query_database", queryInput);
      expect(repeated.isError).not.toBe(true);
      expect(reportingQueries.queryCalls).toEqual([queryInput, queryInput]);
      expect(audit.events.map((event) => event.outcome)).toEqual([
        "success",
        "success",
        "success",
        "success"
      ]);
      expect(audit.events[2]).toMatchObject({
        resource: "company.projects",
        details: {
          toolName: "query_database",
          relation: "assistant_reporting.active_projects",
          rowCount: 1,
          truncated: false,
          selectedColumns: ["name"]
        }
      });
      expect(String(audit.events[2]?.details?.queryShapeHash)).toHaveLength(64);
      expect(JSON.stringify(audit.events[2]?.details)).not.toContain("CRM Geçişi");
    } finally {
      await session.close();
    }
  });

  it("filters discovery by relation ACL and rechecks revocation before any query", async () => {
    const reportingQueries = new MemoryReportingQueries();
    let projectsAllowed = false;
    const permissions: PermissionLookup = {
      has: async (_userId, resource) =>
        resource === "company.database.explore" ||
        (resource === "company.projects" && projectsAllowed)
    };
    const audit = new MemoryAudit();
    const session = await new CompanyMcpSessionFactory({
      reports,
      reportsEnabled: false,
      reportingQueries,
      authorization: new AuthorizationService(permissions),
      audit
    }).open(
      { id: "admin-with-revocation", department: null, role: "admin" },
      { messageId: "message-revocation" }
    );
    const queryInput: ReportingQueryInput = {
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };

    try {
      const hidden = await session.callTool("describe_database", { cursor: null });
      expect(hidden.structuredContent?.database).toMatchObject({ relations: [] });
      const denied = await session.callTool("query_database", queryInput);
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: { code: "permission_denied" }
      });
      expect(reportingQueries.queryCalls).toHaveLength(0);

      projectsAllowed = true;
      const visible = await session.callTool("describe_database", { cursor: null });
      expect(visible.structuredContent?.database).toMatchObject({
        relations: [expect.objectContaining({ name: "assistant_reporting.active_projects" })]
      });
      projectsAllowed = false;
      const revoked = await session.callTool("query_database", queryInput);
      expect(revoked).toMatchObject({
        isError: true,
        structuredContent: { code: "permission_denied" }
      });
      expect(reportingQueries.queryCalls).toHaveLength(0);
      expect(audit.events.filter((event) => event.outcome === "denied")).toHaveLength(2);
      expect(audit.events.at(-1)?.resource).toBe("company.projects");
    } finally {
      await session.close();
    }
  });

  it("does not list or execute database exploration for non-privileged roles", async () => {
    const permissions: PermissionLookup = { has: async () => true };
    const session = await new CompanyMcpSessionFactory({
      reports,
      reportingQueries: new MemoryReportingQueries(),
      authorization: new AuthorizationService(permissions),
      audit: new MemoryAudit()
    }).open(
      { id: "manager-user", department: null, role: "manager" },
      { messageId: "message-manager" }
    );
    try {
      expect((await session.listTools()).map((tool) => tool.name)).toEqual([
        "get_sales_summary",
        "get_active_projects",
        "get_overdue_tasks"
      ]);
      const denied = await session.callTool("describe_database", { cursor: null });
      expect(denied).toMatchObject({
        isError: true,
        structuredContent: { code: "permission_denied" }
      });
    } finally {
      await session.close();
    }
  });

  it("batches relation ACL discovery and rechecks a long-lived actor role", async () => {
    const reportingQueries = new MemoryReportingQueries();
    const batchCalls: string[][] = [];
    const permissions: PermissionLookup = {
      has: async () => true,
      findAllowed: async (_userId, resources) => {
        batchCalls.push([...resources]);
        return new Set(resources);
      }
    };
    let currentActor: { id: string; department: null; role: string } = {
      id: "long-lived-admin",
      department: null,
      role: "admin"
    };
    const session = await new CompanyMcpSessionFactory({
      reports,
      reportsEnabled: false,
      reportingQueries,
      authorization: new AuthorizationService(permissions),
      audit: new MemoryAudit(),
      actorProvider: async () => currentActor
    }).open(currentActor, { messageId: "message-batched-acl" });

    try {
      const schema = await session.callTool("describe_database", { cursor: null });
      expect(schema.isError).not.toBe(true);
      expect(batchCalls).toEqual([
        ["company.database.explore"],
        ["company.projects"]
      ]);

      currentActor = { ...currentActor, role: "employee" };
      const demoted = await session.callTool("describe_database", { cursor: null });
      expect(demoted).toMatchObject({
        isError: true,
        structuredContent: { code: "permission_denied" }
      });
      expect(reportingQueries.discoveryCalls).toHaveLength(1);
      expect(batchCalls).toHaveLength(2);
    } finally {
      await session.close();
    }
  });
});
