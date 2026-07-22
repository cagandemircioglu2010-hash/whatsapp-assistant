import { z } from "zod";
import { reportResources } from "../auth/types.js";

export const MAX_SCHEMA_RESULT_BYTES = 16_000;
export const MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE = 3;
export const BOUNDED_FILTER_OPERATORS = [
  "eq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "starts_with"
] as const;

const postgresIdentifier = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const relationName = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/);
const permissionResource = z
  .string()
  .min(3)
  .max(100)
  .refine(
    (value) =>
      value === reportResources.sales ||
      value === reportResources.projects ||
      value === reportResources.tasks ||
      /^company\.database\.relation\.[a-z][a-z0-9_.-]+$/.test(value),
    { message: "Use a report permission or a company.database.relation.* permission" }
  )
  .refine((value) => value !== reportResources.databaseExplore, {
    message: "A relation needs a separate data permission, not only database-explorer permission"
  });

const policySchema = z
  .object({
    relation: relationName,
    columns: z.array(postgresIdentifier).min(1).max(40),
    filterColumns: z.array(postgresIdentifier).max(10).default([]),
    resource: permissionResource,
    allowUnfiltered: z.boolean().default(false)
  })
  .strict();

export type ReportingRelationPolicy = z.infer<typeof policySchema>;

export const DEFAULT_REPORTING_RELATION_MANIFEST: readonly ReportingRelationPolicy[] = [
  {
    relation: "assistant_reporting.sales_daily",
    columns: [
      "sale_date",
      "currency",
      "completed_sales_count",
      "completed_revenue",
      "refund_count",
      "refunded_amount"
    ],
    filterColumns: [],
    resource: reportResources.sales,
    allowUnfiltered: true
  },
  {
    relation: "assistant_reporting.active_projects",
    columns: [
      "name",
      "department",
      "status",
      "owner_name",
      "start_date",
      "due_date",
      "open_task_count",
      "overdue_task_count"
    ],
    filterColumns: [],
    resource: reportResources.projects,
    allowUnfiltered: true
  },
  {
    relation: "assistant_reporting.overdue_tasks",
    columns: [
      "project_name",
      "department",
      "title",
      "status",
      "assignee_name",
      "priority",
      "due_date",
      "days_overdue"
    ],
    filterColumns: [],
    resource: reportResources.tasks,
    allowUnfiltered: true
  }
];

export const DEFAULT_REPORTING_RELATION_MANIFEST_JSON = JSON.stringify(
  DEFAULT_REPORTING_RELATION_MANIFEST
);

function schemaName(relation: string): string {
  return relation.slice(0, relation.indexOf("."));
}

function isForbiddenSchema(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "public" || normalized === "information_schema" || normalized.startsWith("pg_");
}

export function compareReportingRelationNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertReportingManifestDiscoveryBudget(
  policies: readonly ReportingRelationPolicy[],
  allowedSchemas: readonly string[]
): number {
  const candidates = [...policies]
    .sort((left, right) => compareReportingRelationNames(left.relation, right.relation))
    .map((policy) => ({
      name: policy.relation,
      kind: "view" as const,
      columns: policy.columns.map((name) => ({
        name,
        dataType: "x".repeat(80),
        // `false` is the longer JSON boolean and therefore the safe sizing case.
        nullable: false
      })),
      queryPolicy: {
        requiresFilter: !policy.allowUnfiltered,
        filterColumns: policy.filterColumns,
        approvedOperators: policy.allowUnfiltered ? [] : BOUNDED_FILTER_OPERATORS
      }
    }));
  let pageCount = 1;
  let pageRelations: typeof candidates = [];
  for (const candidate of candidates) {
    const nextRelations = [...pageRelations, candidate];
    const serialized = JSON.stringify({
      schemas: allowedSchemas,
      relations: nextRelations,
      limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
      truncated: false,
      nextCursor: candidate.name
    });
    if (Buffer.byteLength(serialized, "utf8") <= MAX_SCHEMA_RESULT_BYTES) {
      pageRelations = nextRelations;
      continue;
    }
    if (pageRelations.length === 0) {
      throw new Error(`LLM schema relation ${candidate.name} cannot fit in one discovery page`);
    }
    pageCount += 1;
    pageRelations = [candidate];
    if (
      Buffer.byteLength(
        JSON.stringify({
          schemas: allowedSchemas,
          relations: pageRelations,
          limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
          truncated: false,
          nextCursor: candidate.name
        }),
        "utf8"
      ) > MAX_SCHEMA_RESULT_BYTES
    ) {
      throw new Error(`LLM schema relation ${candidate.name} cannot fit in one discovery page`);
    }
  }
  if (pageCount > MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE) {
    throw new Error(
      `LLM schema manifest needs ${pageCount} discovery pages; the maximum is ${MAX_SCHEMA_DISCOVERY_CALLS_PER_MESSAGE}`
    );
  }
  return pageCount;
}

export function parseReportingRelationManifest(
  value: string,
  allowedSchemas: readonly string[]
): ReportingRelationPolicy[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("LLM_SCHEMA_RELATION_MANIFEST must be valid JSON");
  }
  const parsed = z.array(policySchema).min(1).max(50).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`LLM_SCHEMA_RELATION_MANIFEST is invalid: ${parsed.error.issues[0]?.message}`);
  }

  const allowed = new Set(allowedSchemas);
  const relations = new Set<string>();
  for (const policy of parsed.data) {
    const schema = schemaName(policy.relation);
    if (isForbiddenSchema(schema)) {
      throw new Error(`LLM_SCHEMA_RELATION_MANIFEST cannot expose schema ${schema}`);
    }
    if (!allowed.has(schema)) {
      throw new Error(
        `LLM_SCHEMA_RELATION_MANIFEST relation ${policy.relation} is outside LLM_SCHEMA_ALLOWED_SCHEMAS`
      );
    }
    if (relations.has(policy.relation)) {
      throw new Error(`LLM_SCHEMA_RELATION_MANIFEST repeats relation ${policy.relation}`);
    }
    relations.add(policy.relation);
    if (new Set(policy.columns).size !== policy.columns.length) {
      throw new Error(`LLM_SCHEMA_RELATION_MANIFEST repeats a column in ${policy.relation}`);
    }
    if (new Set(policy.filterColumns).size !== policy.filterColumns.length) {
      throw new Error(`LLM_SCHEMA_RELATION_MANIFEST repeats a filter column in ${policy.relation}`);
    }
    if (policy.filterColumns.some((column) => !policy.columns.includes(column))) {
      throw new Error(`LLM_SCHEMA_RELATION_MANIFEST has an unavailable filter column in ${policy.relation}`);
    }
    if (!policy.allowUnfiltered && policy.filterColumns.length === 0) {
      throw new Error(
        `LLM_SCHEMA_RELATION_MANIFEST requires filterColumns when allowUnfiltered is false in ${policy.relation}`
      );
    }
  }
  assertReportingManifestDiscoveryBudget(parsed.data, allowedSchemas);
  return parsed.data;
}
