import { hydrateSecretFiles } from "./secret-source.js";

export type DatabaseTlsConfig = false | { rejectUnauthorized: true; ca?: string };

export function assertSafePostgresUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Database connection string must be a valid URL");
  }
  const forbiddenParameters = new Set(["options"]);
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.username ||
    parsed.pathname.length <= 1 ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((name) => {
      const normalized = name.toLowerCase();
      return normalized.startsWith("ssl") || forbiddenParameters.has(normalized);
    })
  ) {
    throw new Error("Database connection string contains an unsafe protocol or inline security parameter");
  }
}

export function databaseTlsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  target: "app" | "company" = "app"
): DatabaseTlsConfig {
  const env = hydrateSecretFiles(environment);
  const legacy = env.DATABASE_SSL === "true" ? "verify-full" : "disable";
  const appMode = env.DATABASE_SSL_MODE ?? legacy;
  const mode = target === "company" ? env.COMPANY_DATABASE_SSL_MODE ?? appMode : appMode;
  if (mode !== "disable" && mode !== "verify-full") {
    throw new Error(`${target === "company" ? "COMPANY_DATABASE_SSL_MODE" : "DATABASE_SSL_MODE"} is invalid`);
  }
  if (environment.NODE_ENV === "production" && mode !== "verify-full") {
    throw new Error(`${target === "company" ? "COMPANY_DATABASE_SSL_MODE" : "DATABASE_SSL_MODE"} must be verify-full in production`);
  }
  if (mode === "disable") return false;
  const ca =
    target === "company"
      ? env.COMPANY_DATABASE_CA_CERT ?? env.DATABASE_CA_CERT
      : env.DATABASE_CA_CERT;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}
