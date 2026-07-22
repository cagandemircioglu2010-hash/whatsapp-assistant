import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/env.js";
import { createLogger } from "../src/logging/logger.js";
import { legacyHmacKeyRing } from "../src/security/keyed-hash.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

function config(): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 3000,
    logLevel: "silent",
    databaseUrl: "postgresql://test:test@localhost:5432/app",
    companyReadonlyDatabaseUrl: "postgresql://test:test@localhost:5432/company",
    databaseTls: false,
    companyDatabaseTls: false,
    identifierHash: legacyHmacKeyRing("x".repeat(32)),
    auditIntegrity: legacyHmacKeyRing("a".repeat(32)),
    safetyIdentifierSecret: "s".repeat(32),
    defaultPhoneCountry: "TR",
    companyTimezone: "Europe/Istanbul",
    assistantLocale: "tr" as const,
    dataEncryption: null,
    messageRetentionDays: 30,
    messageRecordRetentionDays: 90,
    auditRetentionDays: 365,
    webhookBodyLimitBytes: 16_384,
    userRateLimitPerMinute: 20,
    ingressSenderRateLimitPerMinute: 10,
    ingressGlobalRateLimitPerMinute: 600,
    dataLifecycleIntervalMinutes: 60,
    messageWorkerConcurrency: 4,
    abuseLockoutThresholdPerMinute: 10,
    webhookMessageMaxAgeSeconds: 0,
    integration: { timeoutMs: 4000 },
    whatsapp: { enabled: false, graphApiVersion: "v25.0", requireSignature: true, debugLogging: false },
    llm: {
      enabled: false,
      generalChatEnabled: false,
      provider: "openai",
      model: "test-model",
      reasoningEffort: "low",
      maxToolCalls: 4,
      maxOutputTokens: 700,
      timeoutMs: 1000
    }
  };
}

function pool(): Pool {
  return {
    query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 })
  } as unknown as Pool;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("HTTP application hardening", () => {
  it("serves public service, privacy, and data deletion pages", async () => {
    const app = await buildApp({
      config: config(),
      appPool: pool(),
      companyReadonlyPool: pool(),
      logger: createLogger("silent")
    });
    apps.push(app);

    const service = await app.inject({ method: "GET", url: "/" });
    const privacy = await app.inject({ method: "GET", url: "/privacy" });
    const deletion = await app.inject({ method: "GET", url: "/data-deletion" });

    expect(service.statusCode).toBe(200);
    expect(service.headers["content-type"]).toContain("text/html");
    expect(service.body).toContain("WhatsApp Company Assistant");
    expect(privacy.statusCode).toBe(200);
    expect(privacy.body).toContain("Privacy Policy");
    expect(privacy.body).toContain("Google Gemini");
    expect(deletion.statusCode).toBe(200);
    expect(deletion.body).toContain("Data Deletion Instructions");
    expect(deletion.body).toContain("Data Deletion Request");
  });

  it("sets defensive headers without exposing dependency errors", async () => {
    const app = await buildApp({
      config: config(),
      appPool: pool(),
      companyReadonlyPool: pool(),
      logger: createLogger("silent")
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/webhooks/whatsapp" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.body).not.toContain("postgresql://");
  });

  it("rejects oversized webhook bodies with a generic response", async () => {
    const app = await buildApp({
      config: config(),
      appPool: pool(),
      companyReadonlyPool: pool(),
      logger: createLogger("silent")
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x".repeat(20_000) })
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: "Request body is too large" });
  });
});
