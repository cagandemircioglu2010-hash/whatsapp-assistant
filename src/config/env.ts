import { isSupportedCountry, type CountryCode } from "libphonenumber-js";
import { z } from "zod";
import { parseDataEncryptionConfig, type DataEncryptionConfig } from "../security/encryption.js";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const postgresUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, "Must be a PostgreSQL URL");

function looksLikeWeakSecret(value: string): boolean {
  return /replace|changeme|example|password|secret/i.test(value) || new Set(value).size < 8;
}

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: postgresUrl,
    COMPANY_READONLY_DATABASE_URL: postgresUrl,
    DATABASE_SSL: booleanFromString,
    PHONE_HASH_SECRET: z.string().min(32),
    DEFAULT_PHONE_COUNTRY: z.string().length(2).default("TR"),
    COMPANY_TIMEZONE: z.string().default("Europe/Istanbul"),
    DATA_ENCRYPTION_ACTIVE_KEY_ID: z.string().optional(),
    DATA_ENCRYPTION_KEYS: z.string().optional(),
    MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce.number().int().min(16_384).max(1_048_576).default(262_144),
    USER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(20),
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
    LLM_ENABLED: booleanFromString,
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.6-terra"),
    OPENAI_REASONING_EFFORT: z
      .enum(["none", "low", "medium", "high", "xhigh", "max"])
      .default("low"),
    LLM_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(8).default(4),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(128).max(4000).default(700),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(25000)
  })
  .superRefine((env, context) => {
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
          parseDataEncryptionConfig(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KEY_ID);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["DATA_ENCRYPTION_KEYS"],
            message: error instanceof Error ? error.message : "Encryption key configuration is invalid"
          });
        }
      }
    }

    if (env.NODE_ENV === "production" && looksLikeWeakSecret(env.PHONE_HASH_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PHONE_HASH_SECRET"],
        message: "PHONE_HASH_SECRET is too predictable for production"
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

    if (env.LLM_ENABLED && !env.OPENAI_API_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when LLM_ENABLED=true"
      });
    }
    if (env.LLM_ENABLED && env.NODE_ENV === "production" && (env.OPENAI_API_KEY?.length ?? 0) < 20) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is unexpectedly short"
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
  databaseSsl: boolean;
  phoneHashSecret: string;
  defaultPhoneCountry: CountryCode;
  companyTimezone: string;
  dataEncryption: DataEncryptionConfig | null;
  messageRetentionDays: number;
  webhookBodyLimitBytes: number;
  userRateLimitPerMinute: number;
  messageWorkerConcurrency: number;
  whatsapp: {
    enabled: boolean;
    verifyToken?: string;
    accessToken?: string;
    phoneNumberId?: string;
    graphApiVersion: string;
    appSecret?: string;
    requireSignature: boolean;
  };
  llm: {
    enabled: boolean;
    apiKey?: string;
    model: string;
    reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    maxToolCalls: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = schema.parse(environment);
  const dataEncryption =
    env.DATA_ENCRYPTION_ACTIVE_KEY_ID && env.DATA_ENCRYPTION_KEYS
      ? parseDataEncryptionConfig(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KEY_ID)
      : null;

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    companyReadonlyDatabaseUrl: env.COMPANY_READONLY_DATABASE_URL,
    databaseSsl: env.DATABASE_SSL,
    phoneHashSecret: env.PHONE_HASH_SECRET,
    defaultPhoneCountry: env.DEFAULT_PHONE_COUNTRY.toUpperCase() as CountryCode,
    companyTimezone: env.COMPANY_TIMEZONE,
    dataEncryption,
    messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
    webhookBodyLimitBytes: env.WEBHOOK_BODY_LIMIT_BYTES,
    userRateLimitPerMinute: env.USER_RATE_LIMIT_PER_MINUTE,
    messageWorkerConcurrency: env.MESSAGE_WORKER_CONCURRENCY,
    whatsapp: {
      enabled: env.WHATSAPP_ENABLED,
      ...(env.WHATSAPP_VERIFY_TOKEN ? { verifyToken: env.WHATSAPP_VERIFY_TOKEN } : {}),
      ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
      ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
      graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION,
      ...(env.META_APP_SECRET ? { appSecret: env.META_APP_SECRET } : {}),
      requireSignature: env.REQUIRE_WHATSAPP_SIGNATURE
    },
    llm: {
      enabled: env.LLM_ENABLED,
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
      model: env.OPENAI_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
      maxToolCalls: env.LLM_MAX_TOOL_CALLS,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: env.LLM_TIMEOUT_MS
    }
  };
}
