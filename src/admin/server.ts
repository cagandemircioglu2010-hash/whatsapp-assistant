import "dotenv/config";
import pg from "pg";
import { buildWhitelistAdminApp } from "./app.js";
import { loadWhitelistAdminConfig } from "./config.js";
import { loadAdminSecurityConfig } from "./security-config.js";
import { PostgresWhitelistAdminStore } from "./store.js";
import { EnvelopeEncryption } from "../security/encryption.js";
import { VersionedHmac } from "../security/keyed-hash.js";
import { createLogger, logSafe } from "../logging/logger.js";

const config = loadWhitelistAdminConfig();
const security = loadAdminSecurityConfig();
const logger = createLogger(config.logLevel);
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseTls,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "whatsapp-whitelist-admin",
  options: [
    "-c search_path=pg_catalog,public",
    "-c statement_timeout=10000",
    "-c lock_timeout=2000",
    "-c idle_in_transaction_session_timeout=10000"
  ].join(" ")
});
const store = new PostgresWhitelistAdminStore(
  pool,
  new EnvelopeEncryption(security.encryption),
  new VersionedHmac(security.identifiers),
  new VersionedHmac(security.auditIntegrity),
  config.defaultPhoneCountry
);

await store.assertReady();
const app = await buildWhitelistAdminApp({
  store,
  password: config.password,
  logger,
  production: config.nodeEnv === "production"
});
app.addHook("onClose", async () => store.close());

let shutdownPromise: Promise<void> | null = null;
function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logSafe(logger, "info", { signal }, "Shutting down whitelist administration");
    try {
      await app.close();
      process.exitCode = exitCode;
    } catch (error) {
      logSafe(logger, "error", { error }, "Whitelist administration shutdown failed");
      process.exitCode = 1;
    }
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("unhandledRejection", (error) => {
  logSafe(logger, "error", { error }, "Unhandled whitelist administration rejection");
  void shutdown("unhandledRejection", 1);
});
process.once("uncaughtException", (error) => {
  logSafe(logger, "error", { error }, "Uncaught whitelist administration exception");
  void shutdown("uncaughtException", 1);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  logSafe(logger, "error", { error }, "Whitelist administration failed to start");
  await app.close();
  process.exit(1);
}
