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
import { GeminiChatCompletionsGateway } from "./llm/gemini-chat-completions.gateway.js";
import { CompanyMcpSessionFactory } from "./mcp/session.js";
import { CompanyReportRepository } from "./reports/company-report.repository.js";
import { ReportCommandRouter } from "./reports/report-command-router.js";
import { WhatsAppClient } from "./whatsapp/client.js";
import { registerWhatsAppRoutes } from "./whatsapp/routes.js";
import { EnvelopeEncryption } from "./security/encryption.js";
import { logSafe } from "./logging/logger.js";
import { VersionedHmac } from "./security/keyed-hash.js";
import { PostgresRateLimitStore } from "./security/rate-limiter.js";
import { runDataLifecycleJob } from "./security/data-lifecycle.js";
import { readRuntimeHealth } from "./db/readiness.js";

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
  const shutdownTasks: Array<() => Promise<void>> = [];

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
  const identifiers = new VersionedHmac(dependencies.config.identifierHash);
  const auditIntegrity = new VersionedHmac(dependencies.config.auditIntegrity);
  const rateLimits = new PostgresRateLimitStore(dependencies.appPool);
  const users = new UserRepository(dependencies.appPool, identifiers, encryption);
  const permissions = new PermissionRepository(dependencies.appPool);
  const messages = new MessageRepository(dependencies.appPool, encryption, identifiers);
  const audit = new AuditRepository(dependencies.appPool, auditIntegrity);
  const reports = new CompanyReportRepository(dependencies.companyReadonlyPool);
  const authorization = new AuthorizationService(permissions);
  const router = new ReportCommandRouter(reports, authorization, dependencies.config.companyTimezone);
  let responder: AssistantResponder = router;

  if (dependencies.config.llm.enabled) {
    const gateway = dependencies.config.llm.provider === "gemini"
      ? new GeminiChatCompletionsGateway({
          apiKey: dependencies.config.llm.apiKey!,
          model: dependencies.config.llm.model,
          maxOutputTokens: dependencies.config.llm.maxOutputTokens,
          timeoutMs: dependencies.config.llm.timeoutMs
        })
      : new OpenAIResponsesGateway({
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
      safetyIdentifierSecret: dependencies.config.safetyIdentifierSecret!,
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
      identifiers,
      rateLimits,
      defaultCountry: dependencies.config.defaultPhoneCountry,
      rateLimitPerMinute: dependencies.config.userRateLimitPerMinute,
      ingressSenderRateLimitPerMinute: dependencies.config.ingressSenderRateLimitPerMinute,
      ingressGlobalRateLimitPerMinute: dependencies.config.ingressGlobalRateLimitPerMinute,
      workerConcurrency: dependencies.config.messageWorkerConcurrency
    });
    await registerWhatsAppRoutes(app, {
      config: dependencies.config.whatsapp,
      processor,
      logger: dependencies.logger,
      isDecommissioned: async () => {
        const state = await dependencies.appPool.query<{ decommissioned: boolean }>(
          `SELECT COALESCE(
             (SELECT decommissioned_at IS NOT NULL FROM service_state WHERE singleton = TRUE),
             FALSE
           ) AS decommissioned`
        );
        return state.rows[0]?.decommissioned === true;
      }
    });

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
    shutdownTasks.push(async () => {
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
      const health = await readRuntimeHealth(
        dependencies.appPool,
        dependencies.companyReadonlyPool,
        dependencies.config.dataLifecycleIntervalMinutes
      );
      const healthy =
        health.schemaReady &&
        health.serviceActive &&
        health.lifecycleHealthy &&
        health.companyViewsReady &&
        health.pendingMessages < 5_000;
      return reply.code(healthy ? 200 : 503).send({
        status: healthy ? "ok" : "unhealthy",
        checks: {
          schema: health.schemaReady,
          service: health.serviceActive,
          lifecycle: health.lifecycleHealthy,
          reporting: health.companyViewsReady,
          queue: health.pendingMessages < 5_000
        }
      });
    } catch {
      return reply.code(503).send({ status: "unhealthy" });
    }
  });

  app.get("/health/live", async (_request, reply) => reply.send({ status: "ok" }));

  if (dependencies.config.nodeEnv !== "test") {
    let lifecyclePromise: Promise<void> | null = null;
    const runRetention = () => {
      if (lifecyclePromise) return;
      lifecyclePromise = (async () => {
      try {
        const purged = await runDataLifecycleJob(dependencies.appPool, {
          contentDays: dependencies.config.messageRetentionDays,
          messageRecordDays: dependencies.config.messageRecordRetentionDays,
          auditDays: dependencies.config.auditRetentionDays
        });
        if (purged) {
          logSafe(dependencies.logger, "info", { ...purged }, "Data lifecycle maintenance completed");
        }
      } catch (error) {
        logSafe(dependencies.logger, "error", { error }, "Data lifecycle maintenance failed");
      } finally {
        lifecyclePromise = null;
      }
      })();
    };
    setImmediate(runRetention);
    const retentionTimer = setInterval(
      runRetention,
      dependencies.config.dataLifecycleIntervalMinutes * 60 * 1000
    );
    retentionTimer.unref();
    shutdownTasks.push(async () => {
      clearInterval(retentionTimer);
      await lifecyclePromise;
    });
  }

  app.addHook("onClose", async () => {
    try {
      for (const task of shutdownTasks) {
        try {
          await task();
        } catch (error) {
          logSafe(dependencies.logger, "error", { error }, "Application shutdown task failed");
        }
      }
    } finally {
      encryption?.destroy();
      identifiers.destroy();
      auditIntegrity.destroy();
      for (const key of dependencies.config.dataEncryption?.keys.values() ?? []) key.fill(0);
      for (const key of dependencies.config.identifierHash.keys.values()) key.fill(0);
      for (const key of dependencies.config.auditIntegrity.keys.values()) key.fill(0);
    }
  });

  return app;
}
