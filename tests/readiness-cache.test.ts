import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { readRuntimeHealth } from "../src/db/readiness.js";

describe("runtime company-readiness cache", () => {
  it("single-flights concurrent public health checks", async () => {
    let catalogReads = 0;
    let viewProbes = 0;
    const appPool = {
      query: async () => ({
        rows: [
          {
            schema_ready: true,
            service_active: true,
            lifecycle_healthy: true,
            pending_messages: 0
          }
        ]
      })
    } as unknown as Pool;
    const companyPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("information_schema.columns")) {
            catalogReads += 1;
            return {
              rows: [
                {
                  schema_name: "analytics",
                  relation_name: "metrics",
                  relation_kind: "VIEW",
                  column_name: "metric_name",
                  data_type: "text",
                  type_name: "text",
                  type_schema: "pg_catalog",
                  is_nullable: "NO"
                }
              ]
            };
          }
          if (sql.includes('FROM "analytics"."metrics" WHERE FALSE')) viewProbes += 1;
          return { rows: [] };
        },
        release: () => undefined
      })
    } as unknown as Pool;
    const options = {
      reportsEnabled: false,
      schemaDiscoveryEnabled: true,
      allowedSchemas: ["analytics"],
      relationManifest: [
        {
          relation: "analytics.metrics",
          columns: ["metric_name"],
          filterColumns: ["metric_name"],
          resource: "company.database.relation.metrics",
          allowUnfiltered: false
        }
      ]
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        readRuntimeHealth(appPool, companyPool, 60, options)
      )
    );
    expect(results.every((result) => result.companyViewsReady)).toBe(true);
    expect(catalogReads).toBe(1);
    expect(viewProbes).toBe(1);

    await readRuntimeHealth(appPool, companyPool, 60, options);
    expect(catalogReads).toBe(1);
    expect(viewProbes).toBe(1);
  });
});
