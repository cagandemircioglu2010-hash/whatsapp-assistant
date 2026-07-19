import { isSupportedCountry, type CountryCode } from "libphonenumber-js";
import { z } from "zod";
import { parseDataEncryptionConfig, type DataEncryptionConfig } from "../security/encryption.js";
import {
  legacyHmacKeyRing,
  parseHmacKeyRing,
  type HmacKeyRingConfig
} from "../security/keyed-hash.js";
import { hydrateSecretFiles } from "./secret-source.js";
import { assertSafePostgresUrl, type DatabaseTlsConfig } from "./database-tls.js";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const postgresUrl = z.string().url().refine((value) => {
  try {
    assertSafePostgresUrl(value);
    return true;
  } catch {
    return false;
  }
}, "Must be a PostgreSQL URL without inline TLS or session parameters");

function looksLikeWeakSecret(value: string): boolean {
  return /replace|changeme|example|password|secret/i.test(value) || new Set(value).size < 8;
}

function keyRingLooksWeak(keys: ReadonlyMap<string, Buffer>): boolean {
  const fingerprints = new Set<string>();
  for (const key of keys.values()) {
    if (new Set(key).size < 8) return true;
    const fingerprint = key.toString("base64");
    if (fingerprints.has(fingerprint)) return true;
    fingerprints.add(fingerprint);
  }
  return false;
}

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: postgresUrl,
    COMPANY_READONLY_DATABASE_URL: postgresUrl,
    DATABASE_ADMIN_URL: z.string().optional(),
    COMPANY_DATABASE_ADMIN_URL: z.string().optional(),
    POSTGRES_PASSWORD: z.string().optional(),
    APP_RUNTIME_PASSWORD: z.string().optional(),
    COMPANY_READONLY_PASSWORD: z.string().optional(),
    DATABASE_SSL: booleanFromString,
    DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).optional(),
    DATABASE_CA_CERT: z.string().min(1).optional(),
    DATABASE_CA_CERT_FILE: z.string().min(1).optional(),
    COMPANY_DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).optional(),
    COMPANY_DATABASE_CA_CERT: z.string().min(1).optional(),
    COMPANY_DATABASE_CA_CERT_FILE: z.string().min(1).optional(),
    PHONE_HASH_SECRET: z.string().min(32).optional(),
    IDENTIFIER_HASH_ACTIVE_KEY_ID: z.string().optional(),
    IDENTIFIER_HASH_KEYS: z.string().optional(),
    IDENTIFIER_HASH_KEYS_FILE: z.string().min(1).optional(),
    AUDIT_INTEGRITY_ACTIVE_KEY_ID: z.string().optional(),
    AUDIT_INTEGRITY_KEYS: z.string().optional(),
    AUDIT_INTEGRITY_KEYS_FILE: z.string().min(1).optional(),
    SAFETY_IDENTIFIER_SECRET: z.string().min(32).optional(),
    DEFAULT_PHONE_COUNTRY: z.string().length(2).default("TR"),
    COMPANY_TIMEZONE: z.string().default("Europe/Istanbul"),
    ASSISTANT_LOCALE: z.enum(["tr", "en"]).default("tr"),
    OPS_TOKEN: z.string().min(32).optional(),
    DATA_ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),
    DATA_ENCRYPTION_KEYS: z.string().optional(),
    DATA_ENCRYPTION_KEYS_FILE: z.string().min(1).optional(),
    MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    MESSAGE_RECORD_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(1_048_576).default(262_144),
    USER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(20),
    INGRESS_SENDER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(60),
    INGRESS_GLOBAL_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10000).default(600),
    DATA_LIFECYCLE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
    MESSAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    WHATSAPP_ENABLED: booleanFromString,
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
    META_APP_SECRET: z.string().optional(),
    REQUIRE_WHATSAPP_SIGNATURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    WHATSAPP_DEBUG_LOGGING: booleanFromString,
    LLM_ENABLED: booleanFromString,
    LLM_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.6-terra"),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-3.5-flash"),
    OPENAI_REASONING_EFFORT: z
      .enum(["none", "low", "medium", "high", "xhigh", "max"])
      .default("low"),
    LLM_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(8).default(4),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4000).default(700),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000)
  })
  .superRefine((env, context) => {
    let encryptionKeys: ReadonlyMap<string, Buffer> | null = null;
    let identifierKeys: ReadonlyMap<string, Buffer> | null = null;
    let auditKeys: ReadonlyMap<string, Buffer> | null = null;

    if (!isSupportedCountry(env.DEFAULT_PHONE_COUNTRY.toUpperCase() as CountryCode)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEFAULT_PHONE_COUNTRY"],
        message: "DEFAULT_PHONE_COUNTRY is not supported"
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: env.COMPANY_TIMEZONE }).format();
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COMPANY_TIMEZONE"],
        message: "COMPANY_TIMEZONE is not a valid IANA timezone"
      });
    }

    const encryptionRequired = env.NODE_ENV === "production" || env.WHATSAPP_ENABLED;
    if (encryptionRequired && (!env.DATA_ENCRYPTION_ACTIVE_KEY_ID || !env.DATA_ENCRYPTION_KEYS)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATA_ENCRYPTION_KEYS"],
        message: "Data encryption keys are required in production and when WhatsApp is enabled"
      });
    } else if (env.DATA_ENCRYPTION_ACTIVE_KEY_ID || env.DATA_ENCRYPTION_KEYS) {
      if (!env.DATA_ENCRYPTION_ACTIVE_KEY_ID || !env.DATA_ENCRYPTION_KEYS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATA_ENCRYPTION_KEYS"],
          message: "Both data encryption key settings must be provided"
        });
      } else {
        try {
          const parsed = parseDataEncryptionConfig(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KEY_ID);
          encryptionKeys = parsed.keys;
          if (env.NODE_ENV === "production" && keyRingLooksWeak(parsed.keys)) {
            throw new Error("Production encryption keys must be independently random");
          }
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["DATA_ENCRYPTION_KEYS"],
            message: error instanceof Error ? error.message : "Encryption key configuration is invalid"
          });
        }
      }
    }

    const identifierPair = Boolean(env.IDENTIFIER_HASH_ACTIVE_KEY_ID) === Boolean(env.IDENTIFIER_HASH_KEYS);
    if (!identifierPair) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IDENTIFIER_HASH_KEYS"],
        message: "Both identifier HMAC key settings must be provided"
      });
    } else if (env.IDENTIFIER_HASH_ACTIVE_KEY_ID && env.IDENTIFIER_HASH_KEYS) {
      try {
        const parsed = parseHmacKeyRing(env.IDENTIFIER_HASH_KEYS, env.IDENTIFIER_HASH_ACTIVE_KEY_ID);
        identifierKeys = parsed.keys;
        if (env.NODE_ENV === "production" && keyRingLooksWeak(parsed.keys)) {
          throw new Error("Production identifier HMAC keys must be independently random");
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["IDENTIFIER_HASH_KEYS"],
          message: error instanceof Error ? error.message : "Identifier HMAC key ring is invalid"
        });
      }
    }

    const auditPair = Boolean(env.AUDIT_INTEGRITY_ACTIVE_KEY_ID) === Boolean(env.AUDIT_INTEGRITY_KEYS);
    if (!auditPair) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUDIT_INTEGRITY_KEYS"],
        message: "Both audit integrity HMAC key settings must be provided"
      });
    } else if (env.AUDIT_INTEGRITY_ACTIVE_KEY_ID && env.AUDIT_INTEGRITY_KEYS) {
      try {
        const parsed = parseHmacKeyRing(env.AUDIT_INTEGRITY_KEYS, env.AUDIT_INTEGRITY_ACTIVE_KEY_ID);
        auditKeys = parsed.keys;
        if (env.NODE_ENV === "production" && keyRingLooksWeak(parsed.keys)) {
          throw new Error("Production audit integrity keys must be independently random");
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUDIT_INTEGRITY_KEYS"],
          message: error instanceof Error ? error.message : "Audit integrity HMAC key ring is invalid"
        });
      }
    }

    if (!env.IDENTIFIER_HASH_KEYS && !env.PHONE_HASH_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IDENTIFIER_HASH_KEYS"],
        message: "Identifier HMAC keys are required"
      });
    }
    if (env.NODE_ENV === "production" && !env.IDENTIFIER_HASH_KEYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IDENTIFIER_HASH_KEYS"],
        message: "A versioned identifier HMAC key ring is required in production"
      });
    }
    if (env.NODE_ENV === "production" && !env.AUDIT_INTEGRITY_KEYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUDIT_INTEGRITY_KEYS"],
        message: "A separate audit integrity key ring is required in production"
      });
    }
    if (env.NODE_ENV === "production" && env.PHONE_HASH_SECRET && looksLikeWeakSecret(env.PHONE_HASH_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PHONE_HASH_SECRET"],
        message: "PHONE_HASH_SECRET is too predictable for production"
      });
    }

    if (env.NODE_ENV === "production" && encryptionKeys && identifierKeys && auditKeys) {
      const seen = new Map<string, string>();
      let reusedBy: string | null = null;
      for (const [purpose, keys] of [
        ["data encryption", encryptionKeys],
        ["identifier HMAC", identifierKeys],
        ["audit integrity", auditKeys]
      ] as const) {
        for (const key of keys.values()) {
          const fingerprint = key.toString("base64");
          const previousPurpose = seen.get(fingerprint);
          if (previousPurpose && previousPurpose !== purpose) {
            reusedBy = `${previousPurpose} and ${purpose}`;
            break;
          }
          seen.set(fingerprint, purpose);
        }
        if (reusedBy) break;
      }
      if (reusedBy) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DATA_ENCRYPTION_KEYS"],
          message: `Cryptographic keys must not be reused between ${reusedBy}`
        });
      }

      if (env.SAFETY_IDENTIFIER_SECRET) {
        const rawSafetyFingerprint = Buffer.from(env.SAFETY_IDENTIFIER_SECRET, "utf8").toString("base64");
        if (
          seen.has(rawSafetyFingerprint) ||
          [...seen.keys()].some((fingerprint) => fingerprint === env.SAFETY_IDENTIFIER_SECRET) ||
          env.SAFETY_IDENTIFIER_SECRET === env.PHONE_HASH_SECRET
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["SAFETY_IDENTIFIER_SECRET"],
            message: "The safety identifier secret must be independent from every other key"
          });
        }
      }
    }

    const appTlsMode = env.DATABASE_SSL_MODE ?? (env.DATABASE_SSL ? "verify-full" : "disable");
    const companyTlsMode = env.COMPANY_DATABASE_SSL_MODE ?? appTlsMode;
    if (env.NODE_ENV === "production" && (appTlsMode !== "verify-full" || companyTlsMode !== "verify-full")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_SSL_MODE"],
        message: "Both database connections must use verify-full TLS in production"
      });
    }
    if (env.NODE_ENV === "production") {
      const appUsername = decodeURIComponent(new URL(env.DATABASE_URL).username);
      const companyUsername = decodeURIComponent(new URL(env.COMPANY_READONLY_DATABASE_URL).username);
      if (!appUsername || !companyUsername || appUsername === companyUsername) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["COMPANY_READONLY_DATABASE_URL"],
          message: "Application and reporting connections must use distinct database roles"
        });
      }
      const forbiddenRuntimeSecrets = [
        ["DATABASE_ADMIN_URL", env.DATABASE_ADMIN_URL],
        ["COMPANY_DATABASE_ADMIN_URL", env.COMPANY_DATABASE_ADMIN_URL],
        ["POSTGRES_PASSWORD", env.POSTGRES_PASSWORD],
        ["APP_RUNTIME_PASSWORD", env.APP_RUNTIME_PASSWORD],
        ["COMPANY_READONLY_PASSWORD", env.COMPANY_READONLY_PASSWORD]
      ] as const;
      for (const [name, value] of forbiddenRuntimeSecrets) {
        if (value) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} must not be injected into the production runtime`
          });
        }
      }
    }

    if (env.MESSAGE_RECORD_RETENTION_DAYS < env.MESSAGE_RETENTION_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MESSAGE_RECORD_RETENTION_DAYS"],
        message: "Message record retention cannot be shorter than message content retention"
      });
    }

    if (env.WHATSAPP_ENABLED) {
      const required = [
        ["WHATSAPP_VERIFY_TOKEN", env.WHATSAPP_VERIFY_TOKEN],
        ["WHATSAPP_ACCESS_TOKEN", env.WHATSAPP_ACCESS_TOKEN],
        ["WHATSAPP_PHONE_NUMBER_ID", env.WHATSAPP_PHONE_NUMBER_ID]
      ] as const;

      for (const [name, value] of required) {
        if (!value) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when WHATSAPP_ENABLED=true`
          });
        }
      }

      if (env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_VERIFY_TOKEN.length < 16) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WHATSAPP_VERIFY_TOKEN"],
          message: "WHATSAPP_VERIFY_TOKEN must contain at least 16 characters"
        });
      }
      if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_ACCESS_TOKEN.length < 20) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WHATSAPP_ACCESS_TOKEN"],
          message: "WHATSAPP_ACCESS_TOKEN is unexpectedly short"
        });
      }
      if (env.WHATSAPP_PHONE_NUMBER_ID && !/^\d{5,30}$/.test(env.WHATSAPP_PHONE_NUMBER_ID)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["WHATSAPP_PHONE_NUMBER_ID"],
          message: "WHATSAPP_PHONE_NUMBER_ID must contain only digits"
        });
      }

      if (env.REQUIRE_WHATSAPP_SIGNATURE && !env.META_APP_SECRET) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["META_APP_SECRET"],
          message: "META_APP_SECRET is required when webhook signature verification is enabled"
        });
      }
      if (env.NODE_ENV === "production" && !env.REQUIRE_WHATSAPP_SIGNATURE) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["REQUIRE_WHATSAPP_SIGNATURE"],
          message: "Webhook signature verification cannot be disabled in production"
        });
      }
      if (env.META_APP_SECRET && env.META_APP_SECRET.length < 16) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["META_APP_SECRET"],
          message: "META_APP_SECRET is unexpectedly short"
        });
      }
    }

    const selectedLlmApiKey = env.LLM_PROVIDER === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
    const selectedLlmApiKeyName = env.LLM_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
    if (env.LLM_ENABLED && !selectedLlmApiKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [selectedLlmApiKeyName],
        message: `${selectedLlmApiKeyName} is required when LLM_ENABLED=true`
      });
    }
    if (env.LLM_ENABLED && env.NODE_ENV === "production" && (selectedLlmApiKey?.length ?? 0) < 20) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [selectedLlmApiKeyName],
        message: `${selectedLlmApiKeyName} is unexpectedly short`
      });
    }
    if (env.LLM_ENABLED && !env.SAFETY_IDENTIFIER_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SAFETY_IDENTIFIER_SECRET"],
        message: "A separate safety identifier secret is required when the LLM is enabled"
      });
    }
    if (
      env.LLM_ENABLED &&
      env.NODE_ENV === "production" &&
      env.SAFETY_IDENTIFIER_SECRET &&
      looksLikeWeakSecret(env.SAFETY_IDENTIFIER_SECRET)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SAFETY_IDENTIFIER_SECRET"],
        message: "SAFETY_IDENTIFIER_SECRET is too predictable for production"
      });
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl: string;
  companyReadonlyDatabaseUrl: string;
  databaseTls: DatabaseTlsConfig;
  companyDatabaseTls: DatabaseTlsConfig;
  identifierHash: HmacKeyRingConfig;
  auditIntegrity: HmacKeyRingConfig;
  safetyIdentifierSecret?: string;
  defaultPhoneCountry: CountryCode;
  companyTimezone: string;
  assistantLocale: "tr" | "en";
  opsToken?: string;
  dataEncryption: DataEncryptionConfig | null;
  messageRetentionDays: number;
  messageRecordRetentionDays: number;
  auditRetentionDays: number;
  webhookBodyLimitBytes: number;
  userRateLimitPerMinute: number;
  ingressSenderRateLimitPerMinute: number;
  ingressGlobalRateLimitPerMinute: number;
  dataLifecycleIntervalMinutes: number;
  messageWorkerConcurrency: number;
  whatsapp: {
    enabled: boolean;
    verifyToken?: string;
    accessToken?: string;
    phoneNumberId?: string;
    graphApiVersion: string;
    appSecret?: string;
    requireSignature: boolean;
    debugLogging: boolean;
  };
  llm: {
    enabled: boolean;
    provider: "openai" | "gemini";
    apiKey?: string;
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    maxToolCalls: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = schema.parse(hydrateSecretFiles(environment));
  const dataEncryption =
    env.DATA_ENCRYPTION_ACTIVE_KEY_ID && env.DATA_ENCRYPTION_KEYS
      ? parseDataEncryptionConfig(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KEY_ID)
      : null;

  const identifierHash = env.IDENTIFIER_HASH_ACTIVE_KEY_ID && env.IDENTIFIER_HASH_KEYS
    ? parseHmacKeyRing(env.IDENTIFIER_HASH_KEYS, env.IDENTIFIER_HASH_ACTIVE_KEY_ID)
    : legacyHmacKeyRing(env.PHONE_HASH_SECRET!);
  const auditIntegrity = env.AUDIT_INTEGRITY_ACTIVE_KEY_ID && env.AUDIT_INTEGRITY_KEYS
    ? parseHmacKeyRing(env.AUDIT_INTEGRITY_KEYS, env.AUDIT_INTEGRITY_ACTIVE_KEY_ID)
    : legacyHmacKeyRing(env.PHONE_HASH_SECRET!);
  const appTlsMode = env.DATABASE_SSL_MODE ?? (env.DATABASE_SSL ? "verify-full" : "disable");
  const companyTlsMode = env.COMPANY_DATABASE_SSL_MODE ?? appTlsMode;
  const tls = (mode: "disable" | "verify-full", ca?: string): DatabaseTlsConfig =>
    mode === "disable" ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) };

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    companyReadonlyDatabaseUrl: env.COMPANY_READONLY_DATABASE_URL,
    databaseTls: tls(appTlsMode, env.DATABASE_CA_CERT),
    companyDatabaseTls: tls(companyTlsMode, env.COMPANY_DATABASE_CA_CERT ?? env.DATABASE_CA_CERT),
    identifierHash,
    auditIntegrity,
    ...(env.SAFETY_IDENTIFIER_SECRET
      ? { safetyIdentifierSecret: env.SAFETY_IDENTIFIER_SECRET }
      : {}),
    defaultPhoneCountry: env.DEFAULT_PHONE_COUNTRY.toUpperCase() as CountryCode,
    companyTimezone: env.COMPANY_TIMEZONE,
    assistantLocale: env.ASSISTANT_LOCALE,
    ...(env.OPS_TOKEN ? { opsToken: env.OPS_TOKEN } : {}),
    dataEncryption,
    messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
    messageRecordRetentionDays: env.MESSAGE_RECORD_RETENTION_DAYS,
    auditRetentionDays: env.AUDIT_RETENTION_DAYS,
    webhookBodyLimitBytes: env.WEBHOOK_BODY_LIMIT_BYTES,
    userRateLimitPerMinute: env.USER_RATE_LIMIT_PER_MINUTE,
    ingressSenderRateLimitPerMinute: env.INGRESS_SENDER_RATE_LIMIT_PER_MINUTE,
    ingressGlobalRateLimitPerMinute: env.INGRESS_GLOBAL_RATE_LIMIT_PER_MINUTE,
    dataLifecycleIntervalMinutes: env.DATA_LIFECYCLE_INTERVAL_MINUTES,
    messageWorkerConcurrency: env.MESSAGE_WORKER_CONCURRENCY,
    whatsapp: {
      enabled: env.WHATSAPP_ENABLED,
      ...(env.WHATSAPP_VERIFY_TOKEN ? { verifyToken: env.WHATSAPP_VERIFY_TOKEN } : {}),
      ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
      ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
      graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
      ...(env.META_APP_SECRET ? { appSecret: env.META_APP_SECRET } : {}),
      requireSignature: env.REQUIRE_WHATSAPP_SIGNATURE,
      debugLogging: env.WHATSAPP_DEBUG_LOGGING
    },
    llm: {
      enabled: env.LLM_ENABLED,
      provider: env.LLM_PROVIDER,
      ...(env.LLM_PROVIDER === "gemini"
        ? env.GEMINI_API_KEY
          ? { apiKey: env.GEMINI_API_KEY }
          : {}
        : env.OPENAI_API_KEY
          ? { apiKey: env.OPENAI_API_KEY }
          : {}),
      model: env.LLM_PROVIDER === "gemini" ? env.GEMINI_MODEL : env.OPENAI_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
      maxToolCalls: env.LLM_MAX_TOOL_CALLS,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LLM_TIMEOUT_MS
    }
  };
}
