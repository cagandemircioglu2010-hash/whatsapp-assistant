import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_SCHEMA_RESULT_BYTES,
  ReportingQueryError,
  SchemaQueryRepository,
  type ReportingQueryInput
} from "../src/reports/schema-query.repository.js";

const db = new PGlite();
let catalogReads = 0;
const pool = {
  connect: async () => ({
    query: async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("information_schema.columns")) catalogReads += 1;
      return db.query(sql, parameters);
    },
    release: () => undefined
  })
} as unknown as Pool;

beforeAll(async () => {
  await db.exec(await readFile(new URL("../migrations/002_company_reporting.sql", import.meta.url), "utf8"));
  await db.exec(`
    CREATE VIEW assistant_reporting.settings AS
      SELECT 'gemini_key'::text AS key, 'must-never-leave-the-database'::text AS value;
    INSERT INTO company_source.projects (id, name, department, status, owner_name, due_date)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'Kurumsal Portal', 'Engineering', 'in_progress', 'Demo Owner', CURRENT_DATE + 20),
      ('10000000-0000-4000-8000-000000000002', 'CRM Geçişi', 'Sales', 'blocked', 'Demo Owner', CURRENT_DATE + 5);
    INSERT INTO company_source.tasks (id, project_id, title, status, assignee_name, priority, due_date)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Webhook güvenlik testi', 'in_progress', 'Demo User', 'high', CURRENT_DATE - 2),
      ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'CRM veri eşlemesi', 'blocked', 'Demo User', 'critical', CURRENT_DATE - 5);
    INSERT INTO company_source.sales (occurred_at, amount, currency, status, customer_reference)
    VALUES
      (NOW() - INTERVAL '1 day', 12500, 'TRY', 'completed', 'PRIVATE-1'),
      (NOW() - INTERVAL '2 days', 8200, 'TRY', 'completed', 'PRIVATE-2'),
      (NOW() - INTERVAL '2 days', 900, 'TRY', 'refunded', 'PRIVATE-3');
  `);
});

afterAll(async () => {
  await db.close();
});

describe("schema-aware reporting query repository", () => {
  it("discovers only safe fields from explicitly allowed reporting relations", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const schema = await repository.discoverSchema();

    expect(schema.relations.map((relation) => relation.name).sort()).toEqual([
      "assistant_reporting.active_projects",
      "assistant_reporting.overdue_tasks",
      "assistant_reporting.sales_daily"
    ]);
    expect(schema.limits).toEqual({ maxRows: 50, joinsSupported: false, rawSqlAccepted: false });
    expect(schema.nextCursor).toBeNull();
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toMatch(/customer_reference|project_id|updated_at|\"id\"/i);
    expect(serialized).not.toMatch(/company_source|public\.|settings|gemini_key/i);
  });

  it("paginates the complete bounded catalog without exceeding the schema serialization cap", async () => {
    const relationManifest = Array.from({ length: 5 }, (_, relationIndex) => ({
      relation: `analytics.report_${relationIndex.toString().padStart(2, "0")}`,
      columns: Array.from(
        { length: 40 },
        (_, columnIndex) =>
          `field_${columnIndex.toString().padStart(2, "0")}_${"x".repeat(40)}`
      ),
      filterColumns: [],
      resource: `company.database.relation.report_${relationIndex}`,
      allowUnfiltered: true
    }));
    const rows = Array.from({ length: 5 }, (_, relationIndex) =>
      Array.from({ length: 40 }, (_, columnIndex) => ({
        schema_name: "analytics",
        relation_name: `report_${relationIndex.toString().padStart(2, "0")}`,
        relation_kind: "VIEW",
        column_name: `field_${columnIndex.toString().padStart(2, "0")}_${"x".repeat(40)}`,
        data_type: "character varying",
        type_name: "varchar",
        type_schema: "pg_catalog",
        is_nullable: "NO" as const
      }))
    ).flat();
    const pagedPool = {
      connect: async () => ({
        query: async (sql: string) =>
          sql.includes("information_schema.columns") ? { rows } : { rows: [] },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(pagedPool, ["analytics"], relationManifest);
    const pages = [];
    let cursor: string | null = null;
    for (let index = 0; index < 100; index += 1) {
      const page = await repository.discoverSchema({ cursor });
      pages.push(page);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        MAX_SCHEMA_RESULT_BYTES
      );
      if (page.nextCursor === null) break;
      expect(page.nextCursor).toBe(page.relations.at(-1)?.name);
      cursor = page.nextCursor;
    }

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThanOrEqual(3);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    expect(pages.at(-1)?.truncated).toBe(false);
    const relationNames = pages.flatMap((page) => page.relations.map((relation) => relation.name));
    expect(relationNames).toHaveLength(5);
    expect(new Set(relationNames).size).toBe(5);
    await expect(
      repository.discoverSchema({ cursor: "analytics.missing" })
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("compiles filters and ordering into a bounded parameterized read-only query", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const result = await repository.query({
      relation: "assistant_reporting.active_projects",
      columns: ["name", "department", "status", "open_task_count", "overdue_task_count"],
      filters: [{ column: "status", operator: "eq", value: "blocked", values: [] }],
      group_by: [],
      aggregates: [],
      order_by: [{ target: "overdue_task_count", direction: "desc" }],
      limit: 10
    });

    expect(result).toMatchObject({ rowCount: 1, truncated: false });
    expect(result.rows[0]).toMatchObject({
      name: "CRM Geçişi",
      department: "Sales",
      status: "blocked",
      open_task_count: 1,
      overdue_task_count: 1
    });
  });

  it("supports safe aggregates without accepting expressions or SQL", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const result = await repository.query({
      relation: "assistant_reporting.sales_daily",
      columns: ["currency"],
      filters: [],
      group_by: ["currency"],
      aggregates: [
        { function: "sum", column: "completed_sales_count", alias: "sales_count" },
        { function: "sum", column: "completed_revenue", alias: "sales_total" },
        { function: "sum", column: "refund_count", alias: "refund_count_total" },
        { function: "sum", column: "refunded_amount", alias: "refund_total" }
      ],
      order_by: [{ target: "sales_total", direction: "desc" }],
      limit: 10
    });

    expect(result.rows[0]).toMatchObject({
      currency: "TRY",
      sales_count: "2",
      sales_total: "20700.00",
      refund_count_total: "1",
      refund_total: "900.00"
    });
  });

  it("keeps attacker-controlled filter text in parameters and leaves the source unchanged", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const result = await repository.query({
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [
        {
          column: "name",
          operator: "eq",
          value: "x' OR 1=1; DROP SCHEMA company_source CASCADE; --",
          values: []
        }
      ],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    });
    expect(result.rows).toEqual([]);
    await expect(db.query("SELECT COUNT(*) FROM company_source.projects")).resolves.toMatchObject({
      rows: [{ count: 2 }]
    });
  });

  it("rejects unknown, sensitive, malformed, and unbounded requests before execution", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const base: ReportingQueryInput = {
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };

    await expect(repository.query({ ...base, relation: "public.users" })).rejects.toMatchObject({
      code: "unknown_relation"
    } satisfies Partial<ReportingQueryError>);
    await expect(repository.query({ ...base, columns: ["id"] })).rejects.toMatchObject({
      code: "unknown_column"
    } satisfies Partial<ReportingQueryError>);
    await expect(
      repository.query({ ...base, columns: ["name; DROP TABLE users"] })
    ).rejects.toThrow();
    await expect(repository.query({ ...base, limit: 51 })).rejects.toThrow();
    await expect(
      repository.query({
        ...base,
        columns: [],
        aggregates: [{ function: "sum", column: "name", alias: "bad_sum" }]
      })
    ).rejects.toMatchObject({ code: "invalid_aggregate" } satisfies Partial<ReportingQueryError>);
  });

  it("enforces filter, grouping, aggregate, and ordering invariants", async () => {
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const base: ReportingQueryInput = {
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };

    await expect(repository.query({ ...base, columns: ["name", "name"] })).rejects.toMatchObject({
      code: "invalid_query"
    });
    await expect(
      repository.query({
        ...base,
        filters: [{ column: "name", operator: "in", value: null, values: [] }]
      })
    ).rejects.toMatchObject({ code: "invalid_filter" });
    await expect(
      repository.query({
        ...base,
        filters: [{ column: "name", operator: "is_null", value: "x", values: [] }]
      })
    ).rejects.toMatchObject({ code: "invalid_filter" });
    await expect(
      repository.query({
        ...base,
        filters: [{ column: "open_task_count", operator: "contains", value: "1", values: [] }]
      })
    ).rejects.toMatchObject({ code: "invalid_filter" });
    await expect(
      repository.query({ ...base, group_by: ["name"] })
    ).rejects.toMatchObject({ code: "invalid_group" });
    await expect(
      repository.query({
        ...base,
        aggregates: [{ function: "count", column: null, alias: "row_count" }]
      })
    ).rejects.toMatchObject({ code: "invalid_group" });
    await expect(
      repository.query({ ...base, order_by: [{ target: "status", direction: "asc" }] })
    ).rejects.toMatchObject({ code: "invalid_order" });
    await expect(
      repository.query({
        ...base,
        group_by: ["name"],
        aggregates: [{ function: "count", column: null, alias: "name" }]
      })
    ).rejects.toMatchObject({ code: "invalid_aggregate" });
    await expect(
      repository.query({
        ...base,
        columns: [],
        aggregates: [{ function: "count", column: null, alias: "x".repeat(64) }]
      })
    ).rejects.toThrow();

    const count = await repository.query({
      ...base,
      columns: [],
      aggregates: [{ function: "count", column: null, alias: "row_count" }]
    });
    expect(count.rows[0]).toEqual({ row_count: "2" });
  });

  it("caps returned rows, cell length, and serialized output", async () => {
    const executed: Array<{ sql: string; parameters?: unknown[] }> = [];
    const boundedPool = {
      connect: async () => ({
        query: async (sql: string, parameters?: unknown[]) => {
          executed.push({ sql, ...(parameters ? { parameters } : {}) });
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "assistant_reporting",
                  relation_name: "notes",
                  relation_kind: "VIEW",
                  column_name: "note",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "assistant_reporting"."notes"')) {
            return {
              rows: Array.from({ length: 51 }, (_, index) => ({
                note: `${index}:${"x".repeat(2_000)}\u0000\u202E`
              }))
            };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(boundedPool, ["assistant_reporting"], [
      {
        relation: "assistant_reporting.notes",
        columns: ["note"],
        filterColumns: [],
        resource: "company.database.relation.notes",
        allowUnfiltered: true
      }
    ]);
    const result = await repository.query({
      relation: "assistant_reporting.notes",
      columns: ["note"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 50
    });
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeLessThan(50);
    expect(String(result.rows[0]?.note)).toHaveLength(500);
    expect(JSON.stringify(result.rows)).not.toMatch(/[\u0000\u202E]/);
    expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThanOrEqual(16_000);
    const dataQuery = executed.find((entry) =>
      entry.sql.includes('FROM "assistant_reporting"."notes"')
    );
    expect(dataQuery?.sql).toContain('LEFT(source."note"::text, 500)');
    expect(executed.some((entry) => entry.sql.includes("SET LOCAL work_mem = '4MB'"))).toBe(true);
    expect(executed.some((entry) => entry.sql.includes("SET LOCAL temp_file_limit"))).toBe(false);
    expect(
      executed.some((entry) => entry.sql.includes("SET LOCAL max_parallel_workers_per_gather = 0"))
    ).toBe(true);
  });

  it("rejects unsafe relation kinds/types and unreviewed unfiltered scans before data execution", async () => {
    let dataCalls = 0;
    const unsafePool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "analytics",
                  relation_name: "metrics",
                  relation_kind: "FOREIGN",
                  column_name: "payload",
                  data_type: "jsonb",
                  type_name: "jsonb",
                  type_schema: "pg_catalog",
                  is_nullable: "YES"
                }
              ]
            };
          }
          if (sql.includes('FROM "analytics"."metrics"')) dataCalls += 1;
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(unsafePool, ["analytics"], [
      {
        relation: "analytics.metrics",
        columns: ["payload"],
        filterColumns: ["payload"],
        resource: "company.database.relation.metrics",
        allowUnfiltered: false
      }
    ]);
    expect((await repository.discoverSchema()).relations).toEqual([]);
    expect(await repository.isReady()).toBe(false);
    await expect(
      repository.query({
        relation: "analytics.metrics",
        columns: [],
        filters: [],
        group_by: [],
        aggregates: [{ function: "count", column: null, alias: "row_count" }],
        order_by: [],
        limit: 10
      })
    ).rejects.toMatchObject({ code: "filter_required" });
    expect(dataCalls).toBe(0);
  });

  it("requires a non-trivial approved filter and advertises that policy to the model", async () => {
    let dataCalls = 0;
    const selectivePool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "assistant_reporting",
                  relation_name: "notes",
                  relation_kind: "VIEW",
                  column_name: "note",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                },
                {
                  schema_name: "assistant_reporting",
                  relation_name: "notes",
                  relation_kind: "VIEW",
                  column_name: "category",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "assistant_reporting"."notes"')) dataCalls += 1;
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(selectivePool, ["assistant_reporting"], [
      {
        relation: "assistant_reporting.notes",
        columns: ["note", "category"],
        filterColumns: ["note"],
        resource: "company.database.relation.notes",
        allowUnfiltered: false
      }
    ]);
    expect((await repository.discoverSchema()).relations[0]?.queryPolicy).toEqual({
      requiresFilter: true,
      filterColumns: ["note"],
      approvedOperators: ["eq", "lt", "lte", "gt", "gte", "in", "starts_with"]
    });
    const input: ReportingQueryInput = {
      relation: "assistant_reporting.notes",
      columns: ["note"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };
    const trivialFilters: ReportingQueryInput["filters"] = [
      { column: "note", operator: "is_not_null", value: null, values: [] },
      { column: "note", operator: "contains", value: "", values: [] },
      { column: "note", operator: "starts_with", value: "a", values: [] },
      { column: "note", operator: "in", value: null, values: [""] },
      { column: "category", operator: "eq", value: "internal", values: [] }
    ];
    for (const filter of trivialFilters) {
      await expect(repository.query({ ...input, filters: [filter] })).rejects.toMatchObject({
        code: "filter_required"
      });
    }
    expect(dataCalls).toBe(0);

    const selectiveFilters: ReportingQueryInput["filters"] = [
      { column: "note", operator: "eq", value: "exact", values: [] },
      { column: "note", operator: "gte", value: "m", values: [] },
      { column: "note", operator: "in", value: null, values: ["one", "two"] },
      { column: "note", operator: "starts_with", value: "abc", values: [] }
    ];
    for (const filter of selectiveFilters) {
      await expect(repository.query({ ...input, filters: [filter] })).resolves.toMatchObject({
        rowCount: 0
      });
    }
    expect(dataCalls).toBe(4);
  });

  it("rejects PostgreSQL aggregate/type combinations that the server does not support", async () => {
    const aggregatePool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "analytics",
                  relation_name: "bool_metrics",
                  relation_kind: "VIEW",
                  column_name: "enabled",
                  data_type: "boolean",
                  type_name: "bool",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                },
                {
                  schema_name: "analytics",
                  relation_name: "money_metrics",
                  relation_kind: "VIEW",
                  column_name: "amount",
                  data_type: "money",
                  type_name: "money",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(aggregatePool, ["analytics"], [
      {
        relation: "analytics.bool_metrics",
        columns: ["enabled"],
        filterColumns: [],
        resource: "company.database.relation.bool_metrics",
        allowUnfiltered: true
      },
      {
        relation: "analytics.money_metrics",
        columns: ["amount"],
        filterColumns: [],
        resource: "company.database.relation.money_metrics",
        allowUnfiltered: true
      }
    ]);

    expect((await repository.discoverSchema()).relations.map((relation) => relation.name)).toEqual([
      "analytics.bool_metrics"
    ]);
    await expect(
      repository.query({
        relation: "analytics.bool_metrics",
        columns: [],
        filters: [],
        group_by: [],
        aggregates: [{ function: "min", column: "enabled", alias: "min_enabled" }],
        order_by: [],
        limit: 10
      })
    ).rejects.toMatchObject({ code: "invalid_aggregate" });
    await expect(
      repository.query({
        relation: "analytics.money_metrics",
        columns: [],
        filters: [],
        group_by: [],
        aggregates: [{ function: "avg", column: "amount", alias: "avg_amount" }],
        order_by: [],
        limit: 10
      })
    ).rejects.toMatchObject({ code: "unknown_relation" });
  });

  it("treats wildcard characters in text filters as literals", async () => {
    let dataQuery: { sql: string; parameters?: unknown[] } | null = null;
    const filterPool = {
      connect: async () => ({
        query: async (sql: string, parameters?: unknown[]) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "assistant_reporting",
                  relation_name: "notes",
                  relation_kind: "VIEW",
                  column_name: "note",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "assistant_reporting"."notes"')) {
            dataQuery = { sql, ...(parameters ? { parameters } : {}) };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(filterPool, ["assistant_reporting"], [
      {
        relation: "assistant_reporting.notes",
        columns: ["note"],
        filterColumns: ["note"],
        resource: "company.database.relation.notes",
        allowUnfiltered: true
      }
    ]);
    await repository.query({
      relation: "assistant_reporting.notes",
      columns: ["note"],
      filters: [{ column: "note", operator: "contains", value: "%_\\", values: [] }],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    });
    expect(dataQuery).toMatchObject({ parameters: ["\\%\\_\\\\"] });
    expect((dataQuery as { sql: string } | null)?.sql).toContain("ESCAPE E'\\\\'");
  });

  it("single-flights and caches concurrent schema discovery", async () => {
    catalogReads = 0;
    const repository = new SchemaQueryRepository(pool, ["assistant_reporting"]);
    const results = await Promise.all(Array.from({ length: 100 }, () => repository.discoverSchema()));
    expect(results).toHaveLength(100);
    expect(results.every((result) => result.relations.length === 3)).toBe(true);
    expect(catalogReads).toBe(1);
  });

  it("bounds concurrent database work under query stress", async () => {
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const stressPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "assistant_reporting",
                  relation_name: "active_projects",
                  relation_kind: "VIEW",
                  column_name: "name",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "assistant_reporting"."active_projects"')) {
            activeQueries += 1;
            maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
            await new Promise((resolve) => setTimeout(resolve, 2));
            activeQueries -= 1;
            return { rows: [{ name: "CRM Geçişi" }] };
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(stressPool, ["assistant_reporting"], [
      {
        relation: "assistant_reporting.active_projects",
        columns: ["name"],
        filterColumns: [],
        resource: "company.projects",
        allowUnfiltered: true
      }
    ]);
    const input: ReportingQueryInput = {
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };

    const results = await Promise.all(Array.from({ length: 100 }, () => repository.query(input)));
    expect(results.every((result) => result.rows[0]?.name === "CRM Geçişi")).toBe(true);
    expect(maxActiveQueries).toBe(2);
  });

  it("fails fast when the query queue is full, times out waiters, and recovers without leaking slots", async () => {
    let blocking = true;
    let activeQueries = 0;
    let maxActiveQueries = 0;
    let releases: Array<() => void> = [];
    const controlledPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                {
                  schema_name: "assistant_reporting",
                  relation_name: "active_projects",
                  relation_kind: "VIEW",
                  column_name: "name",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "assistant_reporting"."active_projects"')) {
            activeQueries += 1;
            maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
            try {
              if (blocking) {
                await new Promise<void>((resolve) => releases.push(resolve));
              }
              return { rows: [{ name: "CRM Geçişi" }] };
            } finally {
              activeQueries -= 1;
            }
          }
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const repository = new SchemaQueryRepository(controlledPool, ["assistant_reporting"], [
      {
        relation: "assistant_reporting.active_projects",
        columns: ["name"],
        filterColumns: [],
        resource: "company.projects",
        allowUnfiltered: true
      }
    ]);
    const input: ReportingQueryInput = {
      relation: "assistant_reporting.active_projects",
      columns: ["name"],
      filters: [],
      group_by: [],
      aggregates: [],
      order_by: [],
      limit: 10
    };
    await repository.discoverSchema();

    const operations = Array.from({ length: 131 }, () => repository.query(input));
    const settledPromise = Promise.allSettled(operations);
    for (let index = 0; index < 30 && releases.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(releases).toHaveLength(2);
    blocking = false;
    for (const release of releases.splice(0)) release();
    const settled = await settledPromise;
    const rejected = settled.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "query_overloaded" })
    });
    expect(maxActiveQueries).toBe(2);
    expect(activeQueries).toBe(0);

    vi.useFakeTimers();
    try {
      blocking = true;
      releases = [];
      const first = repository.query(input);
      const second = repository.query(input);
      const timedOut = repository.query(input).then(
        () => ({ code: "resolved" }),
        (error: unknown) => ({ code: (error as { code?: string }).code })
      );
      for (let index = 0; index < 30 && releases.length < 2; index += 1) {
        await Promise.resolve();
      }
      expect(releases).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(timedOut).resolves.toEqual({ code: "query_queue_timeout" });

      blocking = false;
      for (const release of releases.splice(0)) release();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      await expect(repository.query(input)).resolves.toMatchObject({ rowCount: 1 });
      expect(activeQueries).toBe(0);
    } finally {
      blocking = false;
      for (const release of releases.splice(0)) release();
      vi.useRealTimers();
    }
  });
});
