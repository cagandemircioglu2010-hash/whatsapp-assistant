import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabasePool } from "./db/pools.js";
import { createMongoReportingConnection } from "./db/mongodb.js";
import { assertRuntimeReady } from "./db/readiness.js";
import { createReportingQueries } from "./reports/reporting-query.factory.js";
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
const mongoConnection = config.mongodb.enabled
  ? await createMongoReportingConnection({
      uri: config.mongodb.uri!,
      database: config.mongodb.database!,
      connectTimeoutMs: config.mongodb.connectTimeoutMs,
      maxPoolSize: config.mongodb.maxPoolSize
    })
  : null;
const reportingQueries = config.llm.schemaDiscoveryEnabled
  ? createReportingQueries({
      postgresPool: companyReadonlyPool,
      ...(mongoConnection ? { mongoDatabase: mongoConnection.database } : {}),
      allowedSchemas: config.llm.schemaAllowedSchemas,
      relationManifest: config.llm.schemaRelationManifest,
      mongoQueryTimeoutMs: config.mongodb.queryTimeoutMs
    })
  : undefined;

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
      startupAuditIntegrity,
      {
        reportsEnabled: config.companyReportsEnabled,
        schemaDiscoveryEnabled: config.llm.schemaDiscoveryEnabled,
        allowedSchemas: config.llm.schemaAllowedSchemas,
        relationManifest: config.llm.schemaRelationManifest,
        ...(reportingQueries ? { reportingQueries } : {})
      }
    );
  } finally {
    startupEncryption.destroy();
    startupIdentifiers.destroy();
    startupAuditIntegrity.destroy();
  }
}

const app = await buildApp({
  config,
  appPool,
  companyReadonlyPool,
  ...(mongoConnection ? { mongoDatabase: mongoConnection.database } : {}),
  logger
});

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logSafe(logger, "info", { signal }, "Shutting down");
    try {
      await app.close();
      await Promise.all([
        appPool.end(),
        companyReadonlyPool.end(),
        mongoConnection?.client.close()
      ]);
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
  await Promise.all([
    appPool.end(),
    companyReadonlyPool.end(),
    mongoConnection?.client.close()
  ]);
  process.exit(1);
}
