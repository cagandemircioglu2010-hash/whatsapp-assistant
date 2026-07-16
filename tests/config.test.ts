import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  COMPANY_READONLY_DATABASE_URL: "postgresql://reader:pass@localhost:5432/company",
  PHONE_HASH_SECRET: "x".repeat(32),
  WHATSAPP_ENABLED: "false"
};

describe("application configuration", () => {
  it("requires an OpenAI key only when the LLM is enabled", () => {
    expect(() => loadConfig({ ...baseEnvironment, LLM_ENABLED: "true" })).toThrow("OPENAI_API_KEY");
    expect(
      loadConfig({ ...baseEnvironment, LLM_ENABLED: "true", OPENAI_API_KEY: "test-key" }).llm.enabled
    ).toBe(true);
    expect(loadConfig(baseEnvironment).llm.enabled).toBe(false);
  });

  it("requires authenticated encryption and strong secrets in production", () => {
    expect(() => loadConfig({ ...baseEnvironment, NODE_ENV: "production" })).toThrow(
      "DATA_ENCRYPTION_KEYS"
    );

    const key = Buffer.alloc(32, 7).toString("base64");
    const loaded = loadConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
      PHONE_HASH_SECRET: "0123456789abcdefghijklmnopqrstuvwxyzABCDEF",
      DATA_ENCRYPTION_ACTIVE_KEY_ID: "current",
      DATA_ENCRYPTION_KEYS: JSON.stringify({ current: key })
    });
    expect(loaded.dataEncryption?.activeKeyId).toBe("current");
    expect(loaded.messageRetentionDays).toBe(30);
    expect(loaded.messageRecordRetentionDays).toBe(90);
    expect(loaded.auditRetentionDays).toBe(365);
    expect(loaded.messageWorkerConcurrency).toBe(4);
  });

  it("rejects record retention shorter than encrypted content retention", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MESSAGE_RETENTION_DAYS: "30",
        MESSAGE_RECORD_RETENTION_DAYS: "29"
      })
    ).toThrow("Message record retention");
  });

  it("rejects non-PostgreSQL connection URLs", () => {
    expect(() => loadConfig({ ...baseEnvironment, DATABASE_URL: "https://example.com/database" })).toThrow(
      "PostgreSQL"
    );
  });
});
