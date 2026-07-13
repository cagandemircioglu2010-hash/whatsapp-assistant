import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthorizationService } from "../auth/authorization.service.js";
import { PermissionRepository } from "../auth/permission.repository.js";
import { UserRepository } from "../auth/user.repository.js";
import { loadConfig } from "../config/env.js";
import { createDatabasePool } from "../db/pools.js";
import { AuditRepository } from "../messages/audit.repository.js";
import { CompanyReportRepository } from "../reports/company-report.repository.js";
import { normalizePhoneNumber } from "../security/phone.js";
import { createCompanyMcpServer } from "./company-server.js";

const config = loadConfig();
const rawActorPhone = process.env.MCP_ACTOR_PHONE;
if (!rawActorPhone) throw new Error("MCP_ACTOR_PHONE must be set for the standalone MCP server");
const actorPhone = normalizePhoneNumber(rawActorPhone, config.defaultPhoneCountry);
if (!actorPhone) throw new Error("MCP_ACTOR_PHONE is not valid");

const appPool = createDatabasePool(config.databaseUrl, {
  ssl: config.databaseSsl,
  max: 2,
  applicationName: "company-mcp-identity"
});
const readonlyPool = createDatabasePool(config.companyReadonlyDatabaseUrl, {
  ssl: config.databaseSsl,
  max: 2,
  applicationName: "company-mcp-reports",
  forceReadOnly: true
});

try {
  const users = new UserRepository(appPool);
  const actor = await users.findActiveByPhone(actorPhone);
  if (!actor) throw new Error("MCP actor is not an active whitelisted user");

  const server = createCompanyMcpServer({
    actor,
    reports: new CompanyReportRepository(readonlyPool),
    authorization: new AuthorizationService(new PermissionRepository(appPool)),
    audit: new AuditRepository(appPool)
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Company reporting MCP server is running on stdio.\n");

  const shutdown = async () => {
    await server.close();
    await Promise.all([appPool.end(), readonlyPool.end()]);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  await Promise.all([appPool.end(), readonlyPool.end()]);
  const message = error instanceof Error ? error.message : "Unknown MCP startup error";
  process.stderr.write(`MCP server failed: ${message}\n`);
  process.exit(1);
}
