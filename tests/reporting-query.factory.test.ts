import type { Db } from "mongodb";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { FederatedReportingQueryRepository } from "../src/reports/federated-query.repository.js";
import { MongoReportingQueryRepository } from "../src/reports/mongodb-query.repository.js";
import { createReportingQueries } from "../src/reports/reporting-query.factory.js";
import {
  SchemaQueryRepository,
  type ReportingQueries
} from "../src/reports/schema-query.repository.js";
import type { ReportingRelationPolicy } from "../src/reports/schema-policy.js";

const postgresPolicy: ReportingRelationPolicy = {
  source: "postgres",
  relation: "assistant_reporting.sales_daily",
  columns: ["completed_revenue"],
  filterColumns: [],
  resource: "company.sales",
  allowUnfiltered: true
};

const mongoPolicy: ReportingRelationPolicy = {
  source: "mongodb",
  relation: "mongo_reporting.customer_metrics",
  collection: "customer_metrics",
  description: "Monthly customer metrics.",
  columns: ["period", "revenue"],
  fieldDescriptions: {
    period: "Month represented by the record.",
    revenue: "Recognized monthly revenue."
  },
  fieldTypes: { period: "date", revenue: "number" },
  filterColumns: ["period"],
  resource: "company.database.relation.customer-metrics",
  allowUnfiltered: false
};

const postgresPool = {} as Pool;
const mongoDatabase = {} as Db;

function create(
  relationManifest: readonly ReportingRelationPolicy[],
  database?: Db
): ReportingQueries {
  return createReportingQueries({
    postgresPool,
    ...(database ? { mongoDatabase: database } : {}),
    allowedSchemas: ["assistant_reporting", "mongo_reporting"],
    relationManifest,
    mongoQueryTimeoutMs: 2_000
  });
}

describe("reporting query factory", () => {
  it("creates the PostgreSQL adapter when only PostgreSQL policies exist", () => {
    const repository = create([postgresPolicy]);
    expect(repository).toBeInstanceOf(SchemaQueryRepository);
    expect(repository.relationPolicies().map((policy) => policy.relation)).toEqual([
      postgresPolicy.relation
    ]);
  });

  it("creates the MongoDB adapter when only MongoDB policies exist", () => {
    const repository = create([mongoPolicy], mongoDatabase);
    expect(repository).toBeInstanceOf(MongoReportingQueryRepository);
    expect(repository.relationPolicies().map((policy) => policy.relation)).toEqual([
      mongoPolicy.relation
    ]);
  });

  it("creates a federated adapter for mixed sources", () => {
    const repository = create([postgresPolicy, mongoPolicy], mongoDatabase);
    expect(repository).toBeInstanceOf(FederatedReportingQueryRepository);
    expect(repository.relationPolicies().map((policy) => policy.relation)).toEqual([
      postgresPolicy.relation,
      mongoPolicy.relation
    ]);
  });

  it("fails closed when MongoDB policies lack a MongoDB connection", () => {
    expect(() => create([postgresPolicy, mongoPolicy])).toThrow(
      "MongoDB relation policies are configured without a MongoDB connection"
    );
  });
});
