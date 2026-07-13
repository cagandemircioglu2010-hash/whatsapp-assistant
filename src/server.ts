import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { createDatabasePool } from "./db/pools.js";
import { createLogger, logSafe } from "./logging/logger.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const appPool = createDatabasePool(config.databaseUrl, {
  ssl: config.databaseSsl,
  max: 10,
  applicationName: "company-whatsapp-assistant-app"
});
const companyReadonlyPool = createDatabasePool(config.companyReadonlyDatabaseUrl, {
  ssl: config.databaseSsl,
  max: 5,
  applicationName: "company-whatsapp-assistant-reports",
  forceReadOnly: true
});

const app = await buildApp({ config, appPool, companyReadonlyPool, logger });

async function shutdown(signal: string): Promise<void> {
  logSafe(logger, "info", { signal }, "Shutting down");
  await app.close();
  await Promise.all([appPool.end(), companyReadonlyPool.end()]);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logSafe(logger, "error", { error }, "Server failed to start");
  await Promise.all([appPool.end(), companyReadonlyPool.end()]);
  process.exit(1);
}
