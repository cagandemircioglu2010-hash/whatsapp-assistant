import { describe, expect, it } from "vitest";
import { CompanyLlmAssistant } from "../src/llm/company-assistant.js";
import type { LlmGateway, LlmTurnRequest } from "../src/llm/types.js";
import type {
  CompanyMcpSession,
  CompanyMcpSessionFactoryLike,
  McpToolResult
} from "../src/mcp/session.js";

class FakeSession implements CompanyMcpSession {
  calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
  closed = false;

  async listTools() {
    return [
      {
        name: "get_sales_summary",
        description: "Sales summary",
        inputSchema: {
          type: "object",
          properties: {
            start_date: { type: "string" },
            end_date: { type: "string" }
          },
          required: ["start_date", "end_date"],
          additionalProperties: false
        }
      }
    ];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpToolResult> {
    this.calls.push({ name, arguments_ });
    return {
      content: [],
      structuredContent: {
        summary: {
          startDate: "2026-07-07",
          endDate: "2026-07-13",
          currencies: [{ currency: "TRY", completedSalesCount: 5, completedRevenue: "25000.00" }]
        }
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSessionFactory implements CompanyMcpSessionFactoryLike {
  readonly session = new FakeSession();
  actorId: string | null = null;
  async open(actor: { id: string }): Promise<CompanyMcpSession> {
    this.actorId = actor.id;
    return this.session;
  }
}

class TwoTurnGateway implements LlmGateway {
  requests: LlmTurnRequest[] = [];

  async createTurn(request: LlmTurnRequest) {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      return {
        outputText: "",
        replayItems: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "get_sales_summary",
            arguments: '{"start_date":"2026-07-07","end_date":"2026-07-13"}'
          }
        ],
        functionCalls: [
          {
            callId: "call-1",
            name: "get_sales_summary",
            arguments: '{"start_date":"2026-07-07","end_date":"2026-07-13"}'
          }
        ]
      };
    }
    return {
      outputText: "Son 7 günde 5 satış tamamlandı ve toplam 25.000 TL gelir elde edildi.",
      replayItems: [],
      functionCalls: []
    };
  }
}

describe("LLM company assistant", () => {
  it("converts MCP tools to function tools and completes the tool-output loop", async () => {
    const gateway = new TwoTurnGateway();
    const sessions = new FakeSessionFactory();
    const assistant = new CompanyLlmAssistant({
      gateway,
      sessions,
      safetyIdentifierSecret: "s".repeat(32),
      timezone: "Europe/Istanbul",
      maxToolCalls: 4
    });

    const result = await assistant.handle(
      { id: "user-secret-id", fullName: "User", department: "Sales", role: "employee" },
      "Bu haftaki satışlar nasıl?",
      { messageId: "message-1" }
    );

    expect(result).toMatchObject({
      outcome: "success",
      resource: "company.sales",
      resources: ["company.sales"]
    });
    expect(result.text).toContain("5 satış");
    expect(sessions.session.calls).toEqual([
      {
        name: "get_sales_summary",
        arguments_: { start_date: "2026-07-07", end_date: "2026-07-13" }
      }
    ]);
    expect(sessions.session.closed).toBe(true);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.tools[0]).toMatchObject({
      type: "function",
      name: "get_sales_summary",
      strict: true
    });
    expect(JSON.stringify(gateway.requests)).not.toContain("user-secret-id");
    expect(gateway.requests[0]?.safetyIdentifier).toHaveLength(64);
    expect(gateway.requests[1]?.inputItems).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" })
    );
  });

  it("always closes the MCP session when the model fails", async () => {
    const sessions = new FakeSessionFactory();
    const gateway: LlmGateway = {
      createTurn: async () => {
        throw new Error("model unavailable");
      }
    };
    const assistant = new CompanyLlmAssistant({
      gateway,
      sessions,
      safetyIdentifierSecret: "s".repeat(32),
      timezone: "Europe/Istanbul",
      maxToolCalls: 4
    });

    await expect(
      assistant.handle(
        { id: "user-1", fullName: "User", department: null, role: "employee" },
        "Satış özeti",
        { messageId: "message-2" }
      )
    ).rejects.toThrow("model unavailable");
    expect(sessions.session.closed).toBe(true);
  });
});
