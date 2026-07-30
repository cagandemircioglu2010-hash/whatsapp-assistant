import type { Db, Document } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { MongoReportingQueryRepository } from "../src/reports/mongodb-query.repository.js";
import type { ReportingRelationPolicy } from "../src/reports/schema-policy.js";
import type { ReportingQueryInput } from "../src/reports/schema-query.repository.js";

const policy: ReportingRelationPolicy = {
  source: "mongodb",
  relation: "mongo_reporting.customer_metrics",
  collection: "customer_metrics",
  description: "One approved customer performance document per customer and month.",
  columns: [
    "customer.name",
    "customer.country",
    "month",
    "revenue",
    "active"
  ],
  fieldDescriptions: {
    "customer.name": "Customer display name.",
    "customer.country": "Two-letter customer country code.",
    month: "First day of the reporting month.",
    revenue: "Net completed revenue after refunds.",
    active: "Whether the customer account is active."
  },
  fieldTypes: {
    "customer.name": "string",
    "customer.country": "string",
    month: "date",
    revenue: "number",
    active: "boolean"
  },
  filterColumns: ["customer.country", "month"],
  resource: "company.database.relation.customer-metrics",
  allowUnfiltered: false
};

type FakeMongo = {
  database: Db;
  find: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  findRows: Document[];
  aggregateRows: Document[];
};

function fakeMongo(): FakeMongo {
  const state: Pick<FakeMongo, "findRows" | "aggregateRows"> = {
    findRows: [],
    aggregateRows: []
  };
  const find = vi.fn();
  const aggregate = vi.fn();
  const collection = {
    find: (filter: Document, options: Document) => {
      find(filter, options);
      const cursor = {
        sort: vi.fn(() => cursor),
        limit: vi.fn(() => cursor),
        toArray: vi.fn(async () => state.findRows)
      };
      return cursor;
    },
    aggregate: (pipeline: Document[], options: Document) => {
      aggregate(pipeline, options);
      return { toArray: vi.fn(async () => state.aggregateRows) };
    }
  };
  const database = {
    command: vi.fn(async () => ({ ok: 1 })),
    listCollections: vi.fn(() => ({ hasNext: vi.fn(async () => true) })),
    collection: vi.fn(() => collection)
  } as unknown as Db;
  return { database, find, aggregate, ...state };
}

describe("MongoDB schema-aware reporting", () => {
  it("describes only manifest-approved collections with rich business metadata", async () => {
    const mongo = fakeMongo();
    const repository = new MongoReportingQueryRepository(mongo.database, [policy]);

    const schema = await repository.discoverSchema();

    expect(schema.relations).toEqual([
      expect.objectContaining({
        name: "mongo_reporting.customer_metrics",
        source: "mongodb",
        kind: "collection",
        description: policy.description,
        columns: expect.arrayContaining([
          expect.objectContaining({
            name: "revenue",
            dataType: "number",
            description: "Net completed revenue after refunds."
          })
        ])
      })
    ]);
    expect(JSON.stringify(schema)).not.toMatch(/_id|password|token|secret/i);
    await expect(repository.isReady()).resolves.toBe(true);
  });

  it("runs bounded find queries and safely flattens approved dotted fields", async () => {
    const mongo = fakeMongo();
    mongo.findRows.push(
      {
        customer: { name: "Ada Ltd", country: "TR", hidden: "never returned" },
        revenue: 12500,
        secret: "never returned"
      },
      {
        customer: { name: "Bora AŞ", country: "TR" },
        revenue: 8200
      }
    );
    const repository = new MongoReportingQueryRepository(mongo.database, [policy]);
    const result = await repository.query({
      relation: policy.relation,
      columns: ["customer.name", "customer.country", "revenue"],
      filters: [
        {
          column: "customer.country",
          operator: "eq",
          value: "TR",
          values: []
        }
      ],
      group_by: [],
      aggregates: [],
      order_by: [{ target: "revenue", direction: "desc" }],
      limit: 2
    });

    expect(result).toEqual({
      relation: policy.relation,
      columns: ["customer.name", "customer.country", "revenue"],
      rows: [
        { "customer.name": "Ada Ltd", "customer.country": "TR", revenue: 12500 },
        { "customer.name": "Bora AŞ", "customer.country": "TR", revenue: 8200 }
      ],
      rowCount: 2,
      truncated: false
    });
    expect(mongo.find).toHaveBeenCalledWith(
      { "customer.country": "TR" },
      expect.objectContaining({
        projection: {
          _id: 0,
          "customer.name": 1,
          "customer.country": 1,
          revenue: 1
        }
      })
    );
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("never returned");
  });

  it("builds server-owned aggregation pipelines without accepting MongoDB code", async () => {
    const mongo = fakeMongo();
    mongo.aggregateRows.push({ c0: "TR", a0: 20700, a1: 2 });
    const repository = new MongoReportingQueryRepository(mongo.database, [policy]);
    const result = await repository.query({
      relation: policy.relation,
      columns: ["customer.country"],
      filters: [
        {
          column: "month",
          operator: "gte",
          value: "2026-07-01T00:00:00.000Z",
          values: []
        }
      ],
      group_by: ["customer.country"],
      aggregates: [
        { function: "sum", column: "revenue", alias: "total_revenue" },
        { function: "count", column: null, alias: "customer_count" }
      ],
      order_by: [{ target: "total_revenue", direction: "desc" }],
      limit: 10
    });

    expect(result.rows).toEqual([
      { "customer.country": "TR", total_revenue: 20700, customer_count: 2 }
    ]);
    const [pipeline, options] = mongo.aggregate.mock.calls[0]!;
    expect(pipeline).toEqual([
      { $match: { month: { $gte: new Date("2026-07-01T00:00:00.000Z") } } },
      {
        $group: {
          _id: { g0: "$customer.country" },
          a0: { $sum: "$revenue" },
          a1: { $sum: 1 }
        }
      },
      { $project: { _id: 0, c0: "$_id.g0", a0: "$a0", a1: "$a1" } },
      { $sort: { a0: -1 } },
      { $limit: 11 }
    ]);
    expect(options).toEqual({ allowDiskUse: false, maxTimeMS: 2000 });
    expect(JSON.stringify(pipeline)).not.toMatch(/\$where|\$function|\$out|\$merge/);
  });

  it("rejects unknown fields, unsafe aggregates and missing selective filters", async () => {
    const repository = new MongoReportingQueryRepository(fakeMongo().database, [policy]);
    const base: ReportingQueryInput = {
      relation: policy.relation,
      columns: ["customer.name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };

    await expect(repository.query({ ...base, columns: ["secret"] })).rejects.toMatchObject({
      code: "unknown_column"
    });
    await expect(
      repository.query({
        ...base,
        columns: [],
        aggregates: [{ function: "sum", column: "customer.name", alias: "bad_sum" }]
      })
    ).rejects.toMatchObject({ code: "invalid_aggregate" });
    await expect(repository.query(base)).rejects.toMatchObject({ code: "filter_required" });
    await expect(
      repository.query({
        ...base,
        filters: [
          {
            column: "customer.country",
            operator: "eq",
            value: '{"$ne":null}',
            values: []
          }
        ]
      })
    ).resolves.toMatchObject({ rows: [] });
  });
});
