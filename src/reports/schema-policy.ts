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
const fieldPath = z
  .string()
  .min(1)
  .max(127)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    "Use a field name or dotted field path without operators"
  );
const relationName = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/);
const collectionName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^(?!system\.)(?!.*\$)[A-Za-z_][A-Za-z0-9_.-]*$/i);
const businessDescription = z
  .string()
  .trim()
  .min(3)
  .max(1_000)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
    message: "Business descriptions cannot contain control characters"
  });
const fieldType = z.enum(["string", "number", "date", "boolean"]);
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
    source: z.enum(["postgres", "mongodb"]).default("postgres"),
    relation: relationName,
    collection: collectionName.optional(),
    description: businessDescription.optional(),
    columns: z.array(fieldPath).min(1).max(40),
    fieldDescriptions: z.record(fieldPath, businessDescription).default({}),
    fieldTypes: z.record(fieldPath, fieldType).default({}),
    filterColumns: z.array(fieldPath).max(10).default([]),
    resource: permissionResource,
    allowUnfiltered: z.boolean().default(false)
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.source === "mongodb" && !policy.collection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collection"],
        message: "MongoDB relations require an approved collection name"
      });
    }
    if (policy.source === "postgres" && policy.collection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collection"],
        message: "PostgreSQL relations cannot specify a MongoDB collection"
      });
    }
    if (policy.source === "postgres" && policy.columns.some((column) => column.includes("."))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columns"],
        message: "PostgreSQL policies require simple column names"
      });
    }
    for (const field of Object.keys(policy.fieldDescriptions)) {
      if (!policy.columns.includes(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fieldDescriptions", field],
          message: "Field descriptions must refer to an approved field"
        });
      }
    }
    for (const field of Object.keys(policy.fieldTypes)) {
      if (!policy.columns.includes(field)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fieldTypes", field],
          message: "Field types must refer to an approved field"
        });
      }
    }
    if (
      policy.source === "mongodb" &&
      policy.columns.some((column) => policy.fieldTypes[column] === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldTypes"],
        message: "Every approved MongoDB field requires an explicit field type"
      });
    }
    if (policy.source === "mongodb" && !policy.description) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message: "Every MongoDB relation requires a business description"
      });
    }
    if (
      policy.source === "mongodb" &&
      policy.columns.some((column) => policy.fieldDescriptions[column] === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldDescriptions"],
        message: "Every approved MongoDB field requires a business description"
      });
    }
  });

export type ReportingFieldType = z.infer<typeof fieldType>;

// Metadata fields are optional in the public TypeScript contract for backwards
// compatibility with existing programmatic policies. Environment manifests are
// parsed through `policySchema`, which fills the defaults and applies the
// stricter MongoDB requirements before runtime.
export type ReportingRelationPolicy = {
  source?: "postgres" | "mongodb" | undefined;
  relation: string;
  collection?: string | undefined;
  description?: string | undefined;
  columns: string[];
  fieldDescriptions?: Record<string, string> | undefined;
  fieldTypes?: Record<string, ReportingFieldType> | undefined;
  filterColumns: string[];
  resource: string;
  allowUnfiltered: boolean;
};

export const DEFAULT_REPORTING_RELATION_MANIFEST: readonly ReportingRelationPolicy[] = [
  {
    source: "postgres",
    relation: "assistant_reporting.sales_daily",
    description:
      "Completed sales and refunds aggregated by calendar day and currency. Use it for revenue, turnover, sales-count and refund questions.",
    columns: [
      "sale_date",
      "currency",
      "completed_sales_count",
      "completed_revenue",
      "refund_count",
      "refunded_amount"
    ],
    fieldDescriptions: {
      sale_date: "Calendar date represented by this aggregate row.",
      currency: "ISO-style currency code such as TRY, EUR or USD.",
      completed_sales_count: "Number of sales completed on the date.",
      completed_revenue: "Gross revenue from completed sales before subtracting refunds.",
      refund_count: "Number of refunded sales on the date.",
      refunded_amount: "Total value refunded on the date."
    },
    fieldTypes: {},
    filterColumns: [],
    resource: reportResources.sales,
    allowUnfiltered: true
  },
  {
    source: "postgres",
    relation: "assistant_reporting.active_projects",
    description:
      "Current active company projects with ownership, schedule and open-task indicators. Excludes completed and cancelled projects.",
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
    fieldDescriptions: {
      name: "Human-readable project name.",
      department: "Department responsible for the project.",
      status: "Current project status, for example blocked or in_progress.",
      owner_name: "Display name of the project owner when available.",
      start_date: "Date on which the project started.",
      due_date: "Planned project completion date.",
      open_task_count: "Number of project tasks that are not complete or cancelled.",
      overdue_task_count: "Number of currently open tasks past their due date."
    },
    fieldTypes: {},
    filterColumns: [],
    resource: reportResources.projects,
    allowUnfiltered: true
  },
  {
    source: "postgres",
    relation: "assistant_reporting.overdue_tasks",
    description:
      "Open company tasks whose due date has passed, including project, assignee, priority and delay information.",
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
    fieldDescriptions: {
      project_name: "Project to which the overdue task belongs.",
      department: "Department responsible for the project and task.",
      title: "Human-readable task title.",
      status: "Current task status.",
      assignee_name: "Display name of the assigned employee when available.",
      priority: "Business priority such as low, medium, high or critical.",
      due_date: "Date by which the task should have been completed.",
      days_overdue: "Whole number of calendar days past the due date."
    },
    fieldTypes: {},
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
      source: policy.source ?? "postgres",
      ...(policy.description ? { description: policy.description } : {}),
      kind: policy.source === "mongodb" ? "collection" as const : "view" as const,
      columns: policy.columns.map((name) => ({
        name,
        dataType: policy.fieldTypes?.[name] ?? "x".repeat(80),
        // `false` is the longer JSON boolean and therefore the safe sizing case.
        nullable: false,
        ...(policy.fieldDescriptions?.[name]
          ? { description: policy.fieldDescriptions[name] }
          : {})
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
    if (
      policy.source === "mongodb" &&
      policy.columns.some((column) =>
        column.split(".").some((segment) =>
          /(^_?id$|uuid|password|passwd|secret|token|credential|private[_-]?key|api[_-]?key|salt|hash|phone|e?mail|address|national[_-]?id|ssn)/i.test(
            segment
          )
        )
      )
    ) {
      throw new Error(
        `LLM_SCHEMA_RELATION_MANIFEST exposes a blocked MongoDB field in ${policy.relation}`
      );
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
