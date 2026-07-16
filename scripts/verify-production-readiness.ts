import "dotenv/config";
import { loadConfig } from "../src/config/env.js";
import { createDatabasePool } from "../src/db/pools.js";
import { assertRuntimeReady, readRuntimeHealth } from "../src/db/readiness.js";
import { EnvelopeEncryption } from "../src/security/encryption.js";
import { VersionedHmac } from "../src/security/keyed-hash.js";

const config = loadConfig();
if (config.nodeEnv !== "production") throw new Error("NODE_ENV=production is required for this check");
if (!config.dataEncryption) throw new Error("Data encryption configuration is required");
const appPool = createDatabasePool(config.databaseUrl, {
  tls: config.databaseTls,
  max: 2,
  applicationName: "company-assistant-readiness-check"
});
const companyPool = createDatabasePool(config.companyReadonlyDatabaseUrl, {
  tls: config.companyDatabaseTls,
  max: 2,
  applicationName: "company-assistant-reporting-readiness-check",
  forceReadOnly: true
});

try {
  const encryption = new EnvelopeEncryption(config.dataEncryption);
  const identifiers = new VersionedHmac(config.identifierHash);
  const auditIntegrity = new VersionedHmac(config.auditIntegrity);
  try {
    await assertRuntimeReady(appPool, companyPool, encryption, identifiers, auditIntegrity);
  } finally {
    encryption.destroy();
    identifiers.destroy();
    auditIntegrity.destroy();
  }
  const health = await readRuntimeHealth(appPool, companyPool, config.dataLifecycleIntervalMinutes);
  if (!health.schemaReady || !health.serviceActive || !health.companyViewsReady) {
    throw new Error("Runtime readiness checks failed");
  }
  process.stdout.write(
    `Production readiness verified. Lifecycle healthy: ${health.lifecycleHealthy ? "yes" : "pending"}; ` +
      `pending messages: ${health.pendingMessages}.\n`
  );
} finally {
  await Promise.all([appPool.end(), companyPool.end()]);
}
