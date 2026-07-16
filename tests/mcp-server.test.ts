import { describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/auth/authorization.service.js";
import type { PermissionLookup } from "../src/auth/permission.repository.js";
import type { AuditInput, AuditStore } from "../src/messages/audit.repository.js";
import { CompanyMcpSessionFactory } from "../src/mcp/session.js";
import type { CompanyReports } from "../src/reports/company-report.repository.js";

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
      { id: "secret-actor-id", fullName: "Test User", department: "Sales", role: "employee" },
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
      { id: "user-1", fullName: "Test", department: null, role: "employee" },
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
});
