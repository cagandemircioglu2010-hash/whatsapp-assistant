import Fastify, { type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { AuthorizationService } from "./auth/authorization.service.js";
import { FallbackAssistantResponder } from "./assistant/fallback-responder.js";
import type { AssistantResponder } from "./assistant/types.js";
import { PermissionRepository } from "./auth/permission.repository.js";
import { UserRepository } from "./auth/user.repository.js";
import type { AppConfig } from "./config/env.js";
import { AuditRepository } from "./messages/audit.repository.js";
import { MessageProcessor } from "./messages/message-processor.js";
import { MessageRepository } from "./messages/message.repository.js";
import { CompanyLlmAssistant } from "./llm/company-assistant.js";
import { OpenAIResponsesGateway } from "./llm/openai-responses.gateway.js";
import { CompanyMcpSessionFactory } from "./mcp/session.js";
import { CompanyReportRepository } from "./reports/company-report.repository.js";
import { ReportCommandRouter } from "./reports/report-command-router.js";
import { WhatsAppClient } from "./whatsapp/client.js";
import { registerWhatsAppRoutes } from "./whatsapp/routes.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

type AppDependencies = {
  config: AppConfig;
  appPool: Pool;
  companyReadonlyPool: Pool;
  logger: Logger;
};

export async function buildApp(dependencies: AppDependencies) {
  // Application events use the separately configured redacting logger. Fastify's
  // automatic request logger is disabled so request bodies can never be emitted.
  const app = Fastify({ logger: false });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as FastifyRequest).rawBody = rawBody;
    try {
      done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  const users = new UserRepository(dependencies.appPool);
  const permissions = new PermissionRepository(dependencies.appPool);
  const messages = new MessageRepository(dependencies.appPool);
  const audit = new AuditRepository(dependencies.appPool);
  const reports = new CompanyReportRepository(dependencies.companyReadonlyPool);
  const authorization = new AuthorizationService(permissions);
  const router = new ReportCommandRouter(reports, authorization, dependencies.config.companyTimezone);
  let responder: AssistantResponder = router;

  if (dependencies.config.llm.enabled) {
    const gateway = new OpenAIResponsesGateway({
      apiKey: dependencies.config.llm.apiKey!,
      model: dependencies.config.llm.model,
      reasoningEffort: dependencies.config.llm.reasoningEffort,
      maxOutputTokens: dependencies.config.llm.maxOutputTokens,
      timeoutMs: dependencies.config.llm.timeoutMs
    });
    const mcpSessions = new CompanyMcpSessionFactory({ reports, authorization, audit });
    const llmAssistant = new CompanyLlmAssistant({
      gateway,
      sessions: mcpSessions,
      safetyIdentifierSecret: dependencies.config.phoneHashSecret,
      timezone: dependencies.config.companyTimezone,
      maxToolCalls: dependencies.config.llm.maxToolCalls
    });
    responder = new FallbackAssistantResponder(llmAssistant, router, dependencies.logger);
  }

  if (dependencies.config.whatsapp.enabled) {
    const sender = new WhatsAppClient({
      accessToken: dependencies.config.whatsapp.accessToken!,
      phoneNumberId: dependencies.config.whatsapp.phoneNumberId!,
      graphApiVersion: dependencies.config.whatsapp.graphApiVersion
    });
    const processor = new MessageProcessor({
      users,
      messages,
      audit,
      router: responder,
      sender,
      logger: dependencies.logger,
      phoneHashSecret: dependencies.config.phoneHashSecret,
      defaultCountry: dependencies.config.defaultPhoneCountry
    });
    await registerWhatsAppRoutes(app, { config: dependencies.config.whatsapp, processor });
  } else {
    app.get("/webhooks/whatsapp", async (_request, reply) =>
      reply.code(503).send({ error: "WhatsApp integration is disabled" })
    );
    app.post("/webhooks/whatsapp", async (_request, reply) =>
      reply.code(503).send({ error: "WhatsApp integration is disabled" })
    );
  }

  app.get("/health", async (_request, reply) => {
    try {
      await Promise.all([
        dependencies.appPool.query("SELECT 1"),
        dependencies.companyReadonlyPool.query("SELECT 1")
      ]);
      return reply.send({ status: "ok" });
    } catch {
      return reply.code(503).send({ status: "unhealthy" });
    }
  });

  return app;
}
