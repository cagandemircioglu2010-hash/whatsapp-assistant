import type { Db } from "mongodb";
import type { Pool } from "pg";
import { FederatedReportingQueryRepository } from "./federated-query.repository.js";
import { MongoReportingQueryRepository } from "./mongodb-query.repository.js";
import { SchemaQueryRepository, type ReportingQueries } from "./schema-query.repository.js";
import type { ReportingRelationPolicy } from "./schema-policy.js";

export function createReportingQueries(options: {
  postgresPool: Pool;
  mongoDatabase?: Db;
  allowedSchemas: readonly string[];
  relationManifest: readonly ReportingRelationPolicy[];
  mongoQueryTimeoutMs: number;
}): ReportingQueries {
  const postgresPolicies = options.relationManifest.filter(
    (policy) => (policy.source ?? "postgres") === "postgres"
  );
  const mongoPolicies = options.relationManifest.filter(
    (policy) => policy.source === "mongodb"
  );
  const providers: ReportingQueries[] = [];
  if (postgresPolicies.length > 0) {
    const postgresSchemas = [
      ...new Set(postgresPolicies.map((policy) => policy.relation.split(".")[0]!))
    ].filter((schema) => options.allowedSchemas.includes(schema));
    providers.push(
      new SchemaQueryRepository(options.postgresPool, postgresSchemas, postgresPolicies)
    );
  }
  if (mongoPolicies.length > 0) {
    if (!options.mongoDatabase) {
      throw new Error("MongoDB relation policies are configured without a MongoDB connection");
    }
    providers.push(
      new MongoReportingQueryRepository(
        options.mongoDatabase,
        mongoPolicies,
        options.mongoQueryTimeoutMs
      )
    );
  }
  if (providers.length === 0) {
    throw new Error("No schema-aware reporting provider is configured");
  }
  return providers.length === 1
    ? providers[0]!
    : new FederatedReportingQueryRepository(providers);
}
