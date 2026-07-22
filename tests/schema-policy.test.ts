import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORTING_RELATION_MANIFEST_JSON,
  parseReportingRelationManifest
} from "../src/reports/schema-policy.js";

describe("reporting relation manifest", () => {
  it("parses the reviewed default reporting views", () => {
    const manifest = parseReportingRelationManifest(
      DEFAULT_REPORTING_RELATION_MANIFEST_JSON,
      ["assistant_reporting"]
    );
    expect(manifest.map((policy) => policy.relation)).toEqual([
      "assistant_reporting.sales_daily",
      "assistant_reporting.active_projects",
      "assistant_reporting.overdue_tasks"
    ]);
    expect(manifest.every((policy) => policy.resource !== "company.database.explore")).toBe(true);
  });

  it("rejects broad, duplicate, malformed, and explorer-only policies", () => {
    const parse = (value: unknown) =>
      parseReportingRelationManifest(JSON.stringify(value), ["assistant_reporting"]);

    expect(() =>
      parse([
        {
          relation: "public.settings",
          columns: ["key", "value"],
          resource: "company.database.relation.settings"
        }
      ])
    ).toThrow("cannot expose schema public");
    expect(() =>
      parse([
        {
          relation: "assistant_reporting.metrics",
          columns: ["value", "value"],
          resource: "company.database.relation.metrics"
        }
      ])
    ).toThrow("repeats a column");
    expect(() =>
      parse([
        {
          relation: "assistant_reporting.metrics",
          columns: ["value"],
          resource: "company.database.explore"
        }
      ])
    ).toThrow("company.database.relation.* permission");
    expect(() => parseReportingRelationManifest("not-json", ["assistant_reporting"])).toThrow(
      "valid JSON"
    );
    expect(() =>
      parse([
        {
          relation: "assistant_reporting.metrics",
          columns: ["metric_name"],
          resource: "company.database.relation.metrics",
          allowUnfiltered: false
        }
      ])
    ).toThrow("requires filterColumns");
    expect(() =>
      parse([
        {
          relation: "assistant_reporting.metrics",
          columns: ["metric_name"],
          filterColumns: ["missing"],
          resource: "company.database.relation.metrics",
          allowUnfiltered: false
        }
      ])
    ).toThrow("unavailable filter column");
  });

  it("rejects manifests that cannot be discovered within one message", () => {
    const oversized = Array.from({ length: 50 }, (_, relationIndex) => ({
      relation: `assistant_reporting.report_${relationIndex}`,
      columns: Array.from(
        { length: 40 },
        (_, columnIndex) => `column_${columnIndex}_${"x".repeat(40)}`
      ),
      filterColumns: [],
      resource: `company.database.relation.report_${relationIndex}`,
      allowUnfiltered: true
    }));

    expect(() =>
      parseReportingRelationManifest(JSON.stringify(oversized), ["assistant_reporting"])
    ).toThrow(/discovery pages|cannot fit/);
  });
});
