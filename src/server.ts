import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabasePool } from "./db/pools.js";
import { assertRuntimeReady } from "./db/readiness.js";
import { EnvelopeEncryption } from "./security/encryption.js";
import { VersionedHmac } from "./security/keyed-hash.js";
import { createLogger, logSafe } from "./logging/logger.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const appPool = createDatabasePool(config.databaseUrl, {
  tls: config.databaseTls,
  max: 10,
  applicationName: "company-whatsapp-assistant-app"
});
const companyReadonlyPool = createDatabasePool(config.companyReadonlyDatabaseUrl, {
  tls: config.companyDatabaseTls,
  max: 5,
  applicationName: "company-whatsapp-assistant-reports",
  forceReadOnly: true
});

if (config.nodeEnv === "production") {
  if (!config.dataEncryption) throw new Error("Production encryption configuration is missing");
  const startupEncryption = new EnvelopeEncryption(config.dataEncryption);
  const startupIdentifiers = new VersionedHmac(config.identifierHash);
  const startupAuditIntegrity = new VersionedHmac(config.auditIntegrity);
  try {
    await assertRuntimeReady(
      appPool,
      companyReadonlyPool,
      startupEncryption,
      startupIdentifiers,
      startupAuditIntegrity
    );
  } finally {
    startupEncryption.destroy();
    startupIdentifiers.destroy();
    startupAuditIntegrity.destroy();
  }
}

const app = await buildApp({ config, appPool, companyReadonlyPool, logger });

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logSafe(logger, "info", { signal }, "Shutting down");
    try {
      await app.close();
      await Promise.all([appPool.end(), companyReadonlyPool.end()]);
      process.exitCode = exitCode;
    } catch (error) {
      logSafe(logger, "error", { error }, "Graceful shutdown failed");
      process.exitCode = 1;
    }
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("unhandledRejection", (error) => {
  logSafe(logger, "error", { error }, "Unhandled rejection");
  void shutdown("unhandledRejection", 1);
});
process.once("uncaughtException", (error) => {
  logSafe(logger, "error", { error }, "Uncaught exception");
  void shutdown("uncaughtException", 1);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logSafe(logger, "error", { error }, "Server failed to start");
  await Promise.all([appPool.end(), companyReadonlyPool.end()]);
  process.exit(1);
}
