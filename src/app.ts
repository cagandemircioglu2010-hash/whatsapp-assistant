import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
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
import { EnvelopeEncryption } from "./security/encryption.js";
import { logSafe } from "./logging/logger.js";

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
  const app = Fastify({
    logger: false,
    bodyLimit: dependencies.config.webhookBodyLimitBytes,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000
  });

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

  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Permitted-Cross-Domain-Policies", "none");
    if (dependencies.config.nodeEnv === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestedStatus = error.statusCode ?? 500;
    const status = requestedStatus >= 400 && requestedStatus < 500 ? requestedStatus : 500;
    if (status >= 500) {
      logSafe(dependencies.logger, "error", { error, requestId: request.id }, "HTTP request failed");
    }
    const message =
      status === 413
        ? "Request body is too large"
        : status === 415
          ? "Unsupported content type"
          : status >= 500
            ? "Internal server error"
            : "Invalid request";
    return reply.code(status).send({ error: message });
  });

  const encryption = dependencies.config.dataEncryption
    ? new EnvelopeEncryption(dependencies.config.dataEncryption)
    : null;
  const users = new UserRepository(dependencies.appPool, dependencies.config.phoneHashSecret, encryption);
  const permissions = new PermissionRepository(dependencies.appPool);
  const messages = new MessageRepository(dependencies.appPool, encryption);
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
      defaultCountry: dependencies.config.defaultPhoneCountry,
      rateLimitPerMinute: dependencies.config.userRateLimitPerMinute,
      workerConcurrency: dependencies.config.messageWorkerConcurrency
    });
    await registerWhatsAppRoutes(app, { config: dependencies.config.whatsapp, processor });

    let recoveryRunning = false;
    let recoveryPromise: Promise<void> | null = null;
    const recoverPending = async () => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        const recovered = await processor.drainPending();
        if (recovered > 0) {
          logSafe(dependencies.logger, "info", { recovered }, "Recovered pending WhatsApp messages");
        }
      } catch (error) {
        logSafe(dependencies.logger, "error", { error }, "WhatsApp recovery worker failed");
      } finally {
        recoveryRunning = false;
      }
    };
    const scheduleRecovery = () => {
      if (recoveryPromise) return;
      const task = recoverPending();
      recoveryPromise = task;
      void task.finally(() => {
        if (recoveryPromise === task) recoveryPromise = null;
      });
    };
    setImmediate(scheduleRecovery);
    const recoveryTimer = setInterval(scheduleRecovery, 10_000);
    recoveryTimer.unref();
    app.addHook("onClose", async () => {
      clearInterval(recoveryTimer);
      await recoveryPromise;
      const idle = await processor.waitForIdle();
      if (!idle) {
        logSafe(dependencies.logger, "warn", {}, "Shutdown timed out while WhatsApp jobs were active");
      }
    });
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

  app.get("/health/live", async (_request, reply) => reply.send({ status: "ok" }));

  if (encryption) {
    const runRetention = async () => {
      try {
        const purged = await messages.purgeExpiredContent(dependencies.config.messageRetentionDays);
        if (purged > 0) {
          logSafe(dependencies.logger, "info", { purged }, "Expired message content was purged");
        }
      } catch (error) {
        logSafe(dependencies.logger, "error", { error }, "Message retention cleanup failed");
      }
    };
    await runRetention();
    const retentionTimer = setInterval(() => void runRetention(), 6 * 60 * 60 * 1000);
    retentionTimer.unref();
    app.addHook("onClose", async () => clearInterval(retentionTimer));
  }

  return app;
}
