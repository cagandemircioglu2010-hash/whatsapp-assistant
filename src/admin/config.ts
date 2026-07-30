import { getCountries, type CountryCode } from "libphonenumber-js";
import { z } from "zod";
import {
  assertSafePostgresUrl,
  databaseTlsFromEnvironment,
  type DatabaseTlsConfig
} from "../config/database-tls.js";
import { hydrateSecretFiles } from "../config/secret-source.js";

const countries = new Set<string>(getCountries());
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type WhitelistAdminConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: (typeof logLevels)[number];
  databaseUrl: string;
  databaseTls: DatabaseTlsConfig;
  defaultPhoneCountry: CountryCode;
  password: string;
  additionalPermissions: string[];
};

function looksWeak(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    /^(.)(\1){31,}$/.test(value) ||
    /^(password|admin|whatsapp|changeme|secret)/.test(normalized) ||
    new Set(value).size < 10
  );
}

export function loadWhitelistAdminConfig(
  environment: NodeJS.ProcessEnv = process.env
): WhitelistAdminConfig {
  const env = z
    .object({
      NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
      HOST: z.string().min(1).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
      LOG_LEVEL: z.enum(logLevels).default("info"),
      DATABASE_ADMIN_URL: z.string().min(1),
      DEFAULT_PHONE_COUNTRY: z.string().length(2).default("TR"),
      WHITELIST_ADMIN_PASSWORD: z.string().min(32).max(512),
      WHITELIST_ADDITIONAL_PERMISSIONS: z.string().max(8_000).default("")
    })
    .parse(hydrateSecretFiles(environment));

  assertSafePostgresUrl(env.DATABASE_ADMIN_URL);
  const country = env.DEFAULT_PHONE_COUNTRY.toUpperCase();
  if (!countries.has(country)) throw new Error("DEFAULT_PHONE_COUNTRY is not supported");
  if (env.NODE_ENV === "production" && looksWeak(env.WHITELIST_ADMIN_PASSWORD)) {
    throw new Error("WHITELIST_ADMIN_PASSWORD is too predictable for production");
  }
  const additionalPermissions = [
    ...new Set(
      env.WHITELIST_ADDITIONAL_PERMISSIONS
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ];
  if (
    additionalPermissions.length > 50 ||
    additionalPermissions.some(
      (resource) => !/^company\.database\.relation\.[a-z][a-z0-9_.-]+$/.test(resource)
    )
  ) {
    throw new Error(
      "WHITELIST_ADDITIONAL_PERMISSIONS must contain at most 50 comma-separated company.database.relation.* resources"
    );
  }
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_ADMIN_URL,
    databaseTls: databaseTlsFromEnvironment(environment),
    defaultPhoneCountry: country as CountryCode,
    password: env.WHITELIST_ADMIN_PASSWORD,
    additionalPermissions
  };
}
