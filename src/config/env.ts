import type { CountryCode } from "libphonenumber-js";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().url(),
    COMPANY_READONLY_DATABASE_URL: z.string().url(),
    DATABASE_SSL: booleanFromString,
    PHONE_HASH_SECRET: z.string().min(32),
    DEFAULT_PHONE_COUNTRY: z.string().length(2).default("TR"),
    COMPANY_TIMEZONE: z.string().default("Europe/Istanbul"),
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

      if (env.REQUIRE_WHATSAPP_SIGNATURE && !env.META_APP_SECRET) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["META_APP_SECRET"],
          message: "META_APP_SECRET is required when webhook signature verification is enabled"
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
