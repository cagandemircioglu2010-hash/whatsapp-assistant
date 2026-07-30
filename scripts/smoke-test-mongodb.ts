import "dotenv/config";
import { loadConfig } from "../src/config/env.js";
import { createMongoReportingConnection } from "../src/db/mongodb.js";
import { MongoReportingQueryRepository } from "../src/reports/mongodb-query.repository.js";

const config = loadConfig();
if (!config.mongodb.enabled || !config.mongodb.uri || !config.mongodb.database) {
  throw new Error("MongoDB reporting is not enabled or fully configured");
}
const policies = config.llm.schemaRelationManifest.filter(
  (policy) => policy.source === "mongodb"
);
if (policies.length === 0) throw new Error("No approved MongoDB relations are configured");

const connection = await createMongoReportingConnection({
  uri: config.mongodb.uri,
  database: config.mongodb.database,
  connectTimeoutMs: config.mongodb.connectTimeoutMs,
  maxPoolSize: config.mongodb.maxPoolSize
});
try {
  const repository = new MongoReportingQueryRepository(
    connection.database,
    policies,
    config.mongodb.queryTimeoutMs
  );
  if (!(await repository.isReady())) {
    throw new Error("One or more approved MongoDB collections are unavailable");
  }
  const relationNames: string[] = [];
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = await repository.discoverSchema({ cursor });
    relationNames.push(...page.relations.map((relation) => relation.name));
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  if (cursor !== null) throw new Error("MongoDB schema exceeds the discovery budget");
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      database: config.mongodb.database,
      approvedRelations: relationNames
    })}\n`
  );
} finally {
  await connection.client.close();
}
