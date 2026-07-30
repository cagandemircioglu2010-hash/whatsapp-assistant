import { describe, expect, it, vi } from "vitest";
import { FederatedReportingQueryRepository } from "../src/reports/federated-query.repository.js";
import type {
  ReportingQueries,
  ReportingQueryInput,
  ReportingSchema
} from "../src/reports/schema-query.repository.js";
import type { ReportingRelationPolicy } from "../src/reports/schema-policy.js";

function provider(
  policy: ReportingRelationPolicy,
  relation: ReportingSchema["relations"][number]
): ReportingQueries {
  return {
    relationPolicies: () => [policy],
    isReady: vi.fn(async () => true),
    discoverSchema: vi.fn(
      async (_input, allowed = new Set([policy.relation])): Promise<ReportingSchema> => ({
        schemas: allowed.has(policy.relation) ? [policy.relation.split(".")[0]!] : [],
        relations: allowed.has(policy.relation) ? [relation] : [],
        limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
        truncated: false,
        nextCursor: null
      })
    ),
    query: vi.fn(async (input: ReportingQueryInput) => ({
      relation: input.relation,
      columns: input.columns,
      rows: [{ source: policy.source ?? "postgres" }],
      rowCount: 1,
      truncated: false
    }))
  };
}

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
  columns: ["revenue"],
  fieldDescriptions: { revenue: "Net revenue." },
  fieldTypes: { revenue: "number" },
  filterColumns: [],
  resource: "company.database.relation.customer-metrics",
  allowUnfiltered: true
};

describe("federated reporting queries", () => {
  it("combines PostgreSQL and MongoDB schema metadata and dispatches by relation", async () => {
    const postgres = provider(postgresPolicy, {
      name: postgresPolicy.relation,
      source: "postgres",
      kind: "view",
      columns: [{ name: "completed_revenue", dataType: "numeric", nullable: false }],
      queryPolicy: { requiresFilter: false, filterColumns: [], approvedOperators: [] }
    });
    const mongo = provider(mongoPolicy, {
      name: mongoPolicy.relation,
      source: "mongodb",
      description: "Monthly customer metrics.",
      kind: "collection",
      columns: [
        {
          name: "revenue",
          dataType: "number",
          nullable: true,
          description: "Net revenue."
        }
      ],
      queryPolicy: { requiresFilter: false, filterColumns: [], approvedOperators: [] }
    });
    const repository = new FederatedReportingQueryRepository([postgres, mongo]);

    await expect(repository.isReady()).resolves.toBe(true);
    const schema = await repository.discoverSchema();
    expect(schema.relations.map((relation) => `${relation.source}:${relation.name}`)).toEqual([
      "postgres:assistant_reporting.sales_daily",
      "mongodb:mongo_reporting.customer_metrics"
    ]);

    const input: ReportingQueryInput = {
      relation: mongoPolicy.relation,
      columns: ["revenue"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };
    await expect(repository.query(input)).resolves.toMatchObject({
      rows: [{ source: "mongodb" }]
    });
    expect(mongo.query).toHaveBeenCalledOnce();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("rejects duplicate logical relation names across providers", () => {
    const relation: ReportingSchema["relations"][number] = {
      name: postgresPolicy.relation,
      kind: "view",
      columns: [],
      queryPolicy: { requiresFilter: false, filterColumns: [], approvedOperators: [] }
    };
    expect(
      () =>
        new FederatedReportingQueryRepository([
          provider(postgresPolicy, relation),
          provider({ ...postgresPolicy }, relation)
        ])
    ).toThrow("configured more than once");
  });
});
