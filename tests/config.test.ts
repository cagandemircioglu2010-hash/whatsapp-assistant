import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { databaseTlsFromEnvironment } from "../src/config/database-tls.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  COMPANY_READONLY_DATABASE_URL: "postgresql://reader:pass@localhost:5432/company",
  PHONE_HASH_SECRET: "x".repeat(32),
  WHATSAPP_ENABLED: "false"
};

describe("application configuration", () => {
  it("requires the selected provider key only when the LLM is enabled", () => {
    expect(() => loadConfig({ ...baseEnvironment, LLM_ENABLED: "true" })).toThrow("OPENAI_API_KEY");
    expect(
      loadConfig({
        ...baseEnvironment,
        LLM_ENABLED: "true",
        OPENAI_API_KEY: "test-key",
        SAFETY_IDENTIFIER_SECRET: "s".repeat(32)
      }).llm.enabled
    ).toBe(true);
    expect(() =>
      loadConfig({ ...baseEnvironment, LLM_ENABLED: "true", OPENAI_API_KEY: "test-key" })
    ).toThrow("SAFETY_IDENTIFIER_SECRET");
    expect(loadConfig(baseEnvironment).llm.enabled).toBe(false);
    expect(loadConfig(baseEnvironment).llm.generalChatEnabled).toBe(false);
    expect(() =>
      loadConfig({ ...baseEnvironment, LLM_GENERAL_CHAT_ENABLED: "true" })
    ).toThrow("LLM_GENERAL_CHAT_ENABLED requires LLM_ENABLED=true");
    expect(() => loadConfig({ ...baseEnvironment, LLM_PROVIDER: "unsupported" })).toThrow();
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        LLM_ENABLED: "true",
        LLM_PROVIDER: "gemini",
        SAFETY_IDENTIFIER_SECRET: "s".repeat(32)
      })
    ).toThrow("GEMINI_API_KEY");
    expect(
      loadConfig({
        ...baseEnvironment,
        LLM_ENABLED: "true",
        LLM_PROVIDER: "gemini",
        GEMINI_API_KEY: "gemini-test-key",
        LLM_GENERAL_CHAT_ENABLED: "true",
        SAFETY_IDENTIFIER_SECRET: "s".repeat(32)
      }).llm
    ).toMatchObject({
      enabled: true,
      generalChatEnabled: true,
      provider: "gemini",
      apiKey: "gemini-test-key",
      model: "gemini-3.5-flash"
    });
  });

  it("requires authenticated encryption and strong secrets in production", () => {
    expect(() => loadConfig({ ...baseEnvironment, NODE_ENV: "production" })).toThrow(
      "DATA_ENCRYPTION_KEYS"
    );

    const encryptionKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
    const identifierKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33)).toString("base64");
    const auditKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString("base64");
    const loaded = loadConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
      PHONE_HASH_SECRET: undefined,
      DATABASE_SSL_MODE: "verify-full",
      COMPANY_DATABASE_SSL_MODE: "verify-full",
      IDENTIFIER_HASH_ACTIVE_KEY_ID: "current",
      IDENTIFIER_HASH_KEYS: JSON.stringify({ current: identifierKey }),
      AUDIT_INTEGRITY_ACTIVE_KEY_ID: "current",
      AUDIT_INTEGRITY_KEYS: JSON.stringify({ current: auditKey }),
      DATA_ENCRYPTION_ACTIVE_KEY_ID: "current",
      DATA_ENCRYPTION_KEYS: JSON.stringify({ current: encryptionKey })
    });
    expect(loaded.dataEncryption?.activeKeyId).toBe("current");
    expect(loaded.messageRetentionDays).toBe(30);
    expect(loaded.messageRecordRetentionDays).toBe(90);
    expect(loaded.auditRetentionDays).toBe(365);
    expect(loaded.messageWorkerConcurrency).toBe(4);
    expect(loaded.databaseTls).toMatchObject({ rejectUnauthorized: true });
    expect(loaded.identifierHash.activeKeyId).toBe("current");
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

  it("treats blank optional secret-file settings as unset", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        DATABASE_CA_CERT_FILE: "",
        COMPANY_DATABASE_CA_CERT_FILE: "",
        DATA_ENCRYPTION_KEYS_FILE: "",
        IDENTIFIER_HASH_KEYS_FILE: "",
        AUDIT_INTEGRITY_KEYS_FILE: ""
      }).nodeEnv
    ).toBe("development");
  });

  it("accepts only a strong dedicated operations token", () => {
    expect(() => loadConfig({ ...baseEnvironment, OPS_TOKEN: "too-short" })).toThrow("OPS_TOKEN");
    expect(loadConfig({ ...baseEnvironment, OPS_TOKEN: "o".repeat(32) }).opsToken).toBe("o".repeat(32));
  });

  it("requires a complete HTTP(S) integration webhook configuration", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, INTEGRATION_WEBHOOK_URL: "https://ops.example/hook" })
    ).toThrow("INTEGRATION_WEBHOOK_SECRET");
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INTEGRATION_WEBHOOK_URL: "ftp://ops.example/hook",
        INTEGRATION_WEBHOOK_SECRET: "i".repeat(32)
      })
    ).toThrow("HTTP or HTTPS");
    expect(
      loadConfig({
        ...baseEnvironment,
        INTEGRATION_WEBHOOK_URL: "https://ops.example/hook",
        INTEGRATION_WEBHOOK_SECRET: "i".repeat(32)
      }).integration
    ).toMatchObject({ webhookUrl: "https://ops.example/hook", timeoutMs: 4000 });
  });

  it("rejects non-PostgreSQL connection URLs", () => {
    expect(() => loadConfig({ ...baseEnvironment, DATABASE_URL: "https://example.com/database" })).toThrow(
      "PostgreSQL"
    );
  });

  it("rejects cross-purpose key reuse and connection-string session overrides in production", () => {
    const shared = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64");
    const audit = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString("base64");
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
        PHONE_HASH_SECRET: undefined,
        DATABASE_SSL_MODE: "verify-full",
        COMPANY_DATABASE_SSL_MODE: "verify-full",
        IDENTIFIER_HASH_ACTIVE_KEY_ID: "current",
        IDENTIFIER_HASH_KEYS: JSON.stringify({ current: shared }),
        AUDIT_INTEGRITY_ACTIVE_KEY_ID: "current",
        AUDIT_INTEGRITY_KEYS: JSON.stringify({ current: audit }),
        DATA_ENCRYPTION_ACTIVE_KEY_ID: "current",
        DATA_ENCRYPTION_KEYS: JSON.stringify({ current: shared })
      })
    ).toThrow("must not be reused");

    expect(() =>
      loadConfig({ ...baseEnvironment, DATABASE_URL: `${baseEnvironment.DATABASE_URL}?options=-c%20search_path%3Devil` })
    ).toThrow("session parameters");
    expect(() =>
      loadConfig({ ...baseEnvironment, DATABASE_URL: `${baseEnvironment.DATABASE_URL}?SSLMODE=no-verify` })
    ).toThrow("inline TLS");
    expect(() => databaseTlsFromEnvironment({ NODE_ENV: "production" })).toThrow("verify-full");
  });
});
