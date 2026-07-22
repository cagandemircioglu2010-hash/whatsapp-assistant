import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthorizedUser } from "../auth/types.js";
import type { AssistantContext } from "../assistant/types.js";
import { companyToolResources, createCompanyMcpServer } from "./company-server.js";
import type { CompanyReports } from "../reports/company-report.repository.js";
import type { AuditStore } from "../messages/audit.repository.js";
import type { AuthorizationService } from "../auth/authorization.service.js";
import type { ReportingQueries } from "../reports/schema-query.repository.js";

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolResult = {
  content: unknown;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface CompanyMcpSession {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface CompanyMcpSessionFactoryLike {
  open(actor: AuthorizedUser, context: AssistantContext): Promise<CompanyMcpSession>;
}

type FactoryDependencies = {
  reports: CompanyReports;
  actorProvider?: (actor: AuthorizedUser) => Promise<AuthorizedUser | null>;
  reportsEnabled?: boolean;
  reportingQueries?: ReportingQueries;
  authorization: AuthorizationService;
  audit: AuditStore;
};

const databaseExplorerRoles = new Set(["executive", "admin"]);

class InMemoryCompanyMcpSession implements CompanyMcpSession {
  constructor(
    private readonly client: Client,
    private readonly server: McpServer,
    private readonly allowedToolNames: ReadonlySet<string>
  ) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.client.listTools();
    return result.tools
      .filter((tool) => this.allowedToolNames.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown>
      }));
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.client.callTool({ name, arguments: arguments_ });
    return {
      content: result.content,
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent as Record<string, unknown> }
        : {}),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
    };
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.server.close();
  }
}

export class CompanyMcpSessionFactory implements CompanyMcpSessionFactoryLike {
  constructor(private readonly dependencies: FactoryDependencies) {}

  async open(actor: AuthorizedUser, context: AssistantContext): Promise<CompanyMcpSession> {
    const toolResourceEntries = Object.entries(companyToolResources).filter(([toolName]) => {
      if (toolName === "describe_database" || toolName === "query_database") {
        return Boolean(this.dependencies.reportingQueries) && databaseExplorerRoles.has(actor.role.toLowerCase());
      }
      return this.dependencies.reportsEnabled !== false;
    });
    const allowedResources = await this.dependencies.authorization.allowedResources(
      actor.id,
      toolResourceEntries.map(([, resource]) => resource)
    );
    const allowedToolNames = new Set(
      toolResourceEntries
        .filter(([, resource]) => allowedResources.has(resource))
        .map(([toolName]) => toolName)
    );
    const server = createCompanyMcpServer({
      actor,
      ...(this.dependencies.actorProvider
        ? { actorProvider: () => this.dependencies.actorProvider!(actor) }
        : {}),
      messageId: context.messageId,
      reports: this.dependencies.reports,
      ...(typeof this.dependencies.reportsEnabled === "boolean"
        ? { reportsEnabled: this.dependencies.reportsEnabled }
        : {}),
      ...(this.dependencies.reportingQueries
        ? { reportingQueries: this.dependencies.reportingQueries }
        : {}),
      authorization: this.dependencies.authorization,
      audit: this.dependencies.audit
    });
    const client = new Client({ name: "whatsapp-company-assistant", version: "0.2.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return new InMemoryCompanyMcpSession(client, server, allowedToolNames);
  }
}
