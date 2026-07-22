import type { Pool } from "pg";
import { z } from "zod";
import { withReadOnlyTransaction } from "../db/pools.js";
import {
  BOUNDED_FILTER_OPERATORS,
  DEFAULT_REPORTING_RELATION_MANIFEST,
  MAX_SCHEMA_RESULT_BYTES,
  assertReportingManifestDiscoveryBudget,
  compareReportingRelationNames,
  type ReportingRelationPolicy
} from "./schema-policy.js";

export { MAX_SCHEMA_RESULT_BYTES } from "./schema-policy.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, "Use an exact column or output name from the schema tool");
const relationSchema = z
  .string()
  .min(1)
  .max(127)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/,
    "Use an exact schema.relation name from the schema tool"
  );
// Tool inputs stay string-only so both Gemini and OpenAI receive a simple,
// portable JSON schema. PostgreSQL safely coerces parameterized unknown values
// to the compared column type; the model never supplies a cast or expression.
const scalarSchema = z.string().max(500);

export const reportingSchemaInputShape = {
  cursor: relationSchema.nullable()
};

export const reportingSchemaInputSchema = z.object(reportingSchemaInputShape).strict();

export type ReportingSchemaInput = z.infer<typeof reportingSchemaInputSchema>;

export const reportingFilterSchema = z
  .object({
    column: identifierSchema,
    operator: z.enum([
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "starts_with",
      "in",
      "is_null",
      "is_not_null"
    ]),
    value: scalarSchema.nullable(),
    values: z.array(scalarSchema).max(20)
  })
  .strict();

export const reportingAggregateSchema = z
  .object({
    function: z.enum(["count", "sum", "avg", "min", "max"]),
    column: identifierSchema.nullable(),
    alias: identifierSchema
  })
  .strict();

export const reportingOrderSchema = z
  .object({
    target: identifierSchema,
    direction: z.enum(["asc", "desc"])
  })
  .strict();

export const reportingQueryInputShape = {
  relation: relationSchema,
  columns: z.array(identifierSchema).max(12),
  filters: z.array(reportingFilterSchema).max(8),
  group_by: z.array(identifierSchema).max(5),
  aggregates: z.array(reportingAggregateSchema).max(5),
  order_by: z.array(reportingOrderSchema).max(3),
  limit: z.number().int().min(1).max(50)
};

export const reportingQueryInputSchema = z.object(reportingQueryInputShape).strict();

export type ReportingQueryInput = z.infer<typeof reportingQueryInputSchema>;

export type ReportingSchema = {
  schemas: string[];
  relations: Array<{
    name: string;
    kind: "table" | "view" | "foreign_table";
    columns: Array<{
      name: string;
      dataType: string;
      nullable: boolean;
    }>;
    queryPolicy: {
      requiresFilter: boolean;
      filterColumns: string[];
      approvedOperators: string[];
    };
  }>;
  limits: {
    maxRows: number;
    joinsSupported: false;
    rawSqlAccepted: false;
  };
  truncated: boolean;
  nextCursor: string | null;
};

export type ReportingQueryResult = {
  relation: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
};

export interface ReportingQueries {
  relationPolicies(): readonly ReportingRelationPolicy[];
  discoverSchema(
    input?: ReportingSchemaInput,
    allowedRelations?: ReadonlySet<string>
  ): Promise<ReportingSchema>;
  query(
    input: ReportingQueryInput,
    allowedRelations?: ReadonlySet<string>
  ): Promise<ReportingQueryResult>;
  isReady(): Promise<boolean>;
}

type CatalogColumn = {
  name: string;
  dataType: string;
  typeName: string;
  category: "number" | "string" | "date" | "boolean" | "other";
  nullable: boolean;
};

type CatalogRelation = {
  schema: string;
  name: string;
  kind: "view";
  columns: Map<string, CatalogColumn>;
};

type Catalog = {
  relations: Map<string, CatalogRelation>;
  truncated: boolean;
};

type CatalogRow = {
  schema_name: string;
  relation_name: string;
  relation_kind: string;
  column_name: string;
  data_type: string;
  type_name: string;
  type_schema: string;
  is_nullable: "YES" | "NO";
};

const MAX_RELATIONS = 50;
const MAX_COLUMNS_PER_RELATION = 40;
const MAX_RESULT_BYTES = 16_000;
const MAX_CELL_CHARACTERS = 500;
const CATALOG_CACHE_MS = 60_000;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const BLOCKED_COLUMN =
  /(^id$|_id$|uuid|password|passwd|secret|token|credential|private[_-]?key|api[_-]?key|salt|hash|phone|e[_-]?mail|email|address|customer[_-]?reference|national[_-]?id|ssn|created_at|updated_at)/i;
const BLOCKED_RELATION =
  /(^|_)(users?|messages?|audit(?:_events?)?|credentials?|secrets?|tokens?|sessions?|encryption(?:_keys?)?)(_|$)/i;
const NUMBER_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "decimal"
]);
const STRING_TYPES = new Set([
  "text",
  "varchar",
  "bpchar",
  "char",
  "name"
]);
const DATE_TYPES = new Set([
  "date",
  "timestamp",
  "timestamptz",
  "time",
  "timetz",
  "interval"
]);

export class ReportingQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ReportingQueryError";
  }
}

class QuerySemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly capacity: number,
    private readonly maxQueued: number,
    private readonly waitTimeoutMs: number
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let slotTransferred = false;
    if (this.active >= this.capacity) {
      if (this.waiters.length >= this.maxQueued) {
        throw new ReportingQueryError("query_overloaded", "Too many database queries are queued");
      }
      await new Promise<void>((resolve, reject) => {
        let waiter: { resolve: () => void; timer: NodeJS.Timeout };
        waiter = {
          resolve,
          timer: setTimeout(() => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(new ReportingQueryError("query_queue_timeout", "Database query queue timed out"));
          }, this.waitTimeoutMs)
        };
        this.waiters.push(waiter);
      });
      slotTransferred = true;
    }
    if (!slotTransferred) this.active += 1;
    try {
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else {
        this.active -= 1;
      }
    }
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function columnExpression(source: string, column: CatalogColumn): string {
  const raw = `${source}.${quoteIdentifier(column.name)}`;
  return column.category === "string" || column.typeName === "numeric" || column.typeName === "decimal"
    ? `LEFT(${raw}::text, ${MAX_CELL_CHARACTERS})`
    : raw;
}

function rawColumnExpression(source: string, column: CatalogColumn): string {
  return `${source}.${quoteIdentifier(column.name)}`;
}

function sanitizeText(value: string, maxLength = MAX_CELL_CHARACTERS): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .slice(0, maxLength);
}

function normalizeCell(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeText(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return "[binary omitted]";
  const serialized = JSON.stringify(value);
  return sanitizeText(serialized ?? String(value));
}

function category(typeName: string): CatalogColumn["category"] {
  if (NUMBER_TYPES.has(typeName)) return "number";
  if (STRING_TYPES.has(typeName)) return "string";
  if (DATE_TYPES.has(typeName)) return "date";
  if (typeName === "bool") return "boolean";
  return "other";
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ReportingQueryError("invalid_query", `${label} contains duplicate entries`);
  }
}

function validateFilter(filter: z.infer<typeof reportingFilterSchema>, column: CatalogColumn): void {
  const nullOperator = filter.operator === "is_null" || filter.operator === "is_not_null";
  if (nullOperator) {
    if (filter.value !== null || filter.values.length > 0) {
      throw new ReportingQueryError("invalid_filter", "Null filters cannot include values");
    }
    return;
  }
  if (filter.operator === "in") {
    if (filter.value !== null || filter.values.length === 0) {
      throw new ReportingQueryError("invalid_filter", "The in operator requires values only");
    }
    return;
  }
  if (filter.value === null || filter.values.length > 0) {
    throw new ReportingQueryError("invalid_filter", "This filter requires one value");
  }
  if ((filter.operator === "contains" || filter.operator === "starts_with") && column.category !== "string") {
    throw new ReportingQueryError("invalid_filter", "Text matching requires a text column");
  }
}

function validateAggregate(
  aggregate: z.infer<typeof reportingAggregateSchema>,
  relation: CatalogRelation
): void {
  if (aggregate.function === "count" && aggregate.column === null) return;
  if (!aggregate.column) {
    throw new ReportingQueryError("invalid_aggregate", "Only count may omit its column");
  }
  const column = relation.columns.get(aggregate.column);
  if (!column) throw new ReportingQueryError("unknown_column", "Aggregate column is unavailable");
  if ((aggregate.function === "sum" || aggregate.function === "avg") && column.category !== "number") {
    throw new ReportingQueryError("invalid_aggregate", "sum and avg require numeric columns");
  }
  if (
    (aggregate.function === "min" || aggregate.function === "max") &&
    (column.category === "other" || column.category === "boolean")
  ) {
    throw new ReportingQueryError("invalid_aggregate", "min and max require scalar columns");
  }
}

export class SchemaQueryRepository implements ReportingQueries {
  private readonly allowedSchemas: readonly string[];
  private readonly policies: ReadonlyMap<string, ReportingRelationPolicy>;
  private readonly semaphore = new QuerySemaphore(2, 128, 2_000);
  private cachedCatalog: { expiresAt: number; value: Catalog } | null = null;
  private catalogPromise: Promise<Catalog> | null = null;

  constructor(
    private readonly readonlyPool: Pool,
    allowedSchemas: readonly string[],
    relationManifest: readonly ReportingRelationPolicy[] = DEFAULT_REPORTING_RELATION_MANIFEST
  ) {
    if (allowedSchemas.length === 0 || allowedSchemas.length > 10) {
      throw new Error("At least one and at most ten schemas must be allowed");
    }
    if (
      allowedSchemas.some((schema) => {
        const normalized = schema.toLowerCase();
        return normalized === "public" || normalized === "information_schema" || normalized.startsWith("pg_");
      })
    ) {
      throw new Error("System and public schemas cannot be exposed");
    }
    this.allowedSchemas = [...allowedSchemas];
    if (relationManifest.length === 0 || relationManifest.length > MAX_RELATIONS) {
      throw new Error("At least one and at most fifty relation policies are required");
    }
    this.policies = new Map(
      relationManifest.map((policy) => [policy.relation, { ...policy, columns: [...policy.columns] }])
    );
    if (this.policies.size !== relationManifest.length) {
      throw new Error("Relation policies must be unique");
    }
    const allowed = new Set(this.allowedSchemas);
    if ([...this.policies.keys()].some((name) => !allowed.has(name.split(".")[0]!))) {
      throw new Error("Every relation policy must belong to an allowed schema");
    }
    for (const policy of this.policies.values()) {
      const filterColumns = policy.filterColumns ?? [];
      if (filterColumns.some((column) => !policy.columns.includes(column))) {
        throw new Error("Every filter column must belong to its relation policy");
      }
      if (!policy.allowUnfiltered && filterColumns.length === 0) {
        throw new Error("Filtered relation policies require at least one approved filter column");
      }
    }
    assertReportingManifestDiscoveryBudget([...this.policies.values()], this.allowedSchemas);
  }

  relationPolicies(): readonly ReportingRelationPolicy[] {
    return [...this.policies.values()];
  }

  async isReady(): Promise<boolean> {
    try {
      const catalog = await this.catalog();
      if (catalog.relations.size !== this.policies.size) return false;
      await withReadOnlyTransaction(this.readonlyPool, async (client) => {
        for (const relation of catalog.relations.values()) {
          const selections = [...relation.columns.values()]
            .map((column) => `${quoteIdentifier(column.name)}`)
            .join(", ");
          await client.query(
            `SELECT ${selections} FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} WHERE FALSE`
          );
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  async discoverSchema(
    rawInput: ReportingSchemaInput = { cursor: null },
    allowedRelations: ReadonlySet<string> = new Set(this.policies.keys())
  ): Promise<ReportingSchema> {
    const input = reportingSchemaInputSchema.parse(rawInput);
    const catalog = await this.catalog();
    const catalogRelations = [...catalog.relations.entries()]
      .filter(([name]) => allowedRelations.has(name))
      .sort(([left], [right]) => compareReportingRelationNames(left, right));
    const startIndex = input.cursor === null
      ? 0
      : catalogRelations.findIndex(([name]) => name === input.cursor) + 1;
    if (input.cursor !== null && startIndex === 0) {
      throw new ReportingQueryError("invalid_cursor", "Schema cursor is unavailable");
    }
    const relations: ReportingSchema["relations"] = [];
    let nextIndex = startIndex;
    for (; nextIndex < catalogRelations.length; nextIndex += 1) {
      const relation = catalogRelations[nextIndex]![1];
      const policy = this.policies.get(`${relation.schema}.${relation.name}`)!;
      const candidate = {
        name: `${relation.schema}.${relation.name}`,
        kind: relation.kind,
        columns: [...relation.columns.values()].map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable
        })),
        queryPolicy: {
          requiresFilter: !policy.allowUnfiltered,
          filterColumns: [...(policy.filterColumns ?? [])],
          approvedOperators: policy.allowUnfiltered ? [] : [...BOUNDED_FILTER_OPERATORS]
        }
      };
      const candidateRelations = [...relations, candidate];
      const hasMore = nextIndex + 1 < catalogRelations.length;
      const candidatePage: ReportingSchema = {
        schemas: [...new Set(candidateRelations.map((item) => item.name.split(".")[0]!))],
        relations: candidateRelations,
        limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
        truncated: catalog.truncated || hasMore,
        nextCursor: hasMore ? candidate.name : null
      };
      if (
        Buffer.byteLength(JSON.stringify(candidatePage), "utf8") > MAX_SCHEMA_RESULT_BYTES
      ) {
        break;
      }
      relations.push(candidate);
    }
    if (relations.length === 0 && startIndex < catalogRelations.length) {
      throw new ReportingQueryError("schema_page_too_large", "Schema page cannot be represented safely");
    }
    const hasMore = nextIndex < catalogRelations.length;
    const page: ReportingSchema = {
      schemas: [...new Set(relations.map((item) => item.name.split(".")[0]!))],
      relations,
      limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
      truncated: catalog.truncated || hasMore,
      nextCursor: hasMore ? relations.at(-1)!.name : null
    };
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_SCHEMA_RESULT_BYTES) {
      throw new ReportingQueryError("schema_page_too_large", "Schema page cannot be represented safely");
    }
    return page;
  }

  async query(
    rawInput: ReportingQueryInput,
    allowedRelations: ReadonlySet<string> = new Set(this.policies.keys())
  ): Promise<ReportingQueryResult> {
    const input = reportingQueryInputSchema.parse(rawInput);
    const policy = this.policies.get(input.relation);
    if (!policy || !allowedRelations.has(input.relation)) {
      throw new ReportingQueryError("unknown_relation", "Relation is unavailable");
    }
    const approvedFilterColumns = new Set(policy.filterColumns ?? []);
    const hasBoundedFilter = input.filters.some((filter) => {
      if (!approvedFilterColumns.has(filter.column)) return false;
      if (["eq", "lt", "lte", "gt", "gte"].includes(filter.operator)) {
        return typeof filter.value === "string" && filter.value.length > 0;
      }
      if (filter.operator === "starts_with") {
        return typeof filter.value === "string" && filter.value.trim().length >= 3;
      }
      return filter.operator === "in" && filter.values.some((value) => value.length > 0);
    });
    if (!policy.allowUnfiltered && !hasBoundedFilter) {
      throw new ReportingQueryError(
        "filter_required",
        "This reporting relation requires an approved selective filter"
      );
    }
    return this.semaphore.run(async () => {
      const catalog = await this.catalog();
      const relation = catalog.relations.get(input.relation);
      if (!relation) throw new ReportingQueryError("unknown_relation", "Relation is unavailable");
      if (input.columns.length === 0 && input.aggregates.length === 0) {
        throw new ReportingQueryError("invalid_query", "Select at least one column or aggregate");
      }
      unique(input.columns, "columns");
      unique(input.group_by, "group_by");
      unique(input.aggregates.map((aggregate) => aggregate.alias), "aggregate aliases");
      if (
        input.aggregates.some(
          (aggregate) => input.columns.includes(aggregate.alias)
        )
      ) {
        throw new ReportingQueryError(
          "invalid_aggregate",
          "Aggregate aliases cannot duplicate selected columns"
        );
      }

      for (const columnName of [...input.columns, ...input.group_by]) {
        if (!relation.columns.has(columnName)) {
          throw new ReportingQueryError("unknown_column", "Requested column is unavailable");
        }
      }
      for (const filter of input.filters) {
        const column = relation.columns.get(filter.column);
        if (!column) throw new ReportingQueryError("unknown_column", "Filter column is unavailable");
        validateFilter(filter, column);
      }
      for (const aggregate of input.aggregates) validateAggregate(aggregate, relation);

      if (input.aggregates.length > 0) {
        if (input.columns.some((column) => !input.group_by.includes(column))) {
          throw new ReportingQueryError("invalid_group", "Selected columns must be grouped in aggregate queries");
        }
      } else if (input.group_by.length > 0) {
        throw new ReportingQueryError("invalid_group", "group_by requires an aggregate");
      }

      const aggregateAliases = new Set(input.aggregates.map((aggregate) => aggregate.alias));
      const orderTargets = new Set([...input.columns, ...aggregateAliases]);
      for (const order of input.order_by) {
        if (!orderTargets.has(order.target)) {
          throw new ReportingQueryError("invalid_order", "Order target must be selected");
        }
      }

      const source = "source";
      const selections = input.columns.map((columnName) => {
        const column = relation.columns.get(columnName)!;
        return `${columnExpression(source, column)} AS ${quoteIdentifier(columnName)}`;
      });
      const aggregateExpressions = new Map<string, string>();
      for (const aggregate of input.aggregates) {
        const argument = aggregate.column
          ? rawColumnExpression(source, relation.columns.get(aggregate.column)!)
          : "*";
        const aggregateExpression = `${aggregate.function.toUpperCase()}(${argument})`;
        aggregateExpressions.set(aggregate.alias, aggregateExpression);
        selections.push(
          `LEFT((${aggregateExpression})::text, ${MAX_CELL_CHARACTERS}) AS ${quoteIdentifier(aggregate.alias)}`
        );
      }

      const values: unknown[] = [];
      const predicates: string[] = [];
      const parameter = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      for (const filter of input.filters) {
        const column = `${source}.${quoteIdentifier(filter.column)}`;
        switch (filter.operator) {
          case "eq":
            predicates.push(`${column} = ${parameter(filter.value)}`);
            break;
          case "ne":
            predicates.push(`${column} <> ${parameter(filter.value)}`);
            break;
          case "lt":
            predicates.push(`${column} < ${parameter(filter.value)}`);
            break;
          case "lte":
            predicates.push(`${column} <= ${parameter(filter.value)}`);
            break;
          case "gt":
            predicates.push(`${column} > ${parameter(filter.value)}`);
            break;
          case "gte":
            predicates.push(`${column} >= ${parameter(filter.value)}`);
            break;
          case "contains":
            predicates.push(
              `${column} ILIKE '%' || ${parameter(escapeLikePattern(filter.value!))} || '%' ESCAPE E'\\\\'`
            );
            break;
          case "starts_with":
            predicates.push(
              `${column} ILIKE ${parameter(escapeLikePattern(filter.value!))} || '%' ESCAPE E'\\\\'`
            );
            break;
          case "in": {
            const placeholders = filter.values.map((value) => parameter(value));
            predicates.push(`${column} IN (${placeholders.join(", ")})`);
            break;
          }
          case "is_null":
            predicates.push(`${column} IS NULL`);
            break;
          case "is_not_null":
            predicates.push(`${column} IS NOT NULL`);
            break;
        }
      }

      const groupBy = input.group_by.length
        ? ` GROUP BY ${input.group_by
            .map((column) => rawColumnExpression(source, relation.columns.get(column)!))
            .join(", ")}`
        : "";
      const orderBy = input.order_by.length
        ? ` ORDER BY ${input.order_by
            .map((order) => {
              const aggregateExpression = aggregateExpressions.get(order.target);
              const target = aggregateExpression
                ? aggregateExpression
                : rawColumnExpression(source, relation.columns.get(order.target)!);
              return `${target} ${order.direction.toUpperCase()}`;
            })
            .join(", ")}`
        : "";
      const text = `SELECT ${selections.join(", ")}
        FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} AS ${source}${
          predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""
        }${groupBy}${orderBy}
        LIMIT ${input.limit + 1}`;

      const rawRows = await withReadOnlyTransaction(this.readonlyPool, async (client) => {
        await client.query("SET LOCAL statement_timeout = '2s'");
        await client.query("SET LOCAL lock_timeout = '250ms'");
        await client.query("SET LOCAL work_mem = '4MB'");
        await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
        return (await client.query<Record<string, unknown>>(text, values)).rows;
      });

      let truncated = rawRows.length > input.limit;
      const rows: Array<Record<string, unknown>> = [];
      for (const rawRow of rawRows.slice(0, input.limit)) {
        const normalized = Object.fromEntries(
          Object.entries(rawRow).map(([key, value]) => [sanitizeText(key, 128), normalizeCell(value)])
        );
        const candidate = [...rows, normalized];
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RESULT_BYTES) {
          truncated = true;
          break;
        }
        rows.push(normalized);
      }
      return {
        relation: input.relation,
        columns: [...input.columns, ...input.aggregates.map((aggregate) => aggregate.alias)],
        rows,
        rowCount: rows.length,
        truncated
      };
    });
  }

  private async catalog(): Promise<Catalog> {
    if (this.cachedCatalog && this.cachedCatalog.expiresAt > Date.now()) {
      return this.cachedCatalog.value;
    }
    if (this.catalogPromise) return this.catalogPromise;
    this.catalogPromise = this.loadCatalog();
    try {
      const value = await this.catalogPromise;
      this.cachedCatalog = { expiresAt: Date.now() + CATALOG_CACHE_MS, value };
      return value;
    } finally {
      this.catalogPromise = null;
    }
  }

  private async loadCatalog(): Promise<Catalog> {
    const allowedRelations = [...this.policies.keys()];
    const allowedColumnNames = [
      ...new Set([...this.policies.values()].flatMap((policy) => policy.columns))
    ];
    const rows = await withReadOnlyTransaction(this.readonlyPool, async (client) => {
      const result = await client.query<CatalogRow>(
        `SELECT c.table_schema AS schema_name,
                c.table_name AS relation_name,
                CASE WHEN t.table_type = 'VIEW' THEN 'VIEW'
                     WHEN t.table_type = 'FOREIGN' THEN 'FOREIGN'
                     ELSE 'TABLE' END AS relation_kind,
                c.column_name,
                c.data_type,
                c.udt_name AS type_name,
                c.udt_schema AS type_schema,
                c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = ANY($1::text[])
           AND (c.table_schema || '.' || c.table_name) = ANY($2::text[])
           AND c.column_name = ANY($3::text[])
           AND t.table_type = 'VIEW'
           AND c.udt_schema = 'pg_catalog'
         ORDER BY c.table_schema, c.table_name, c.ordinal_position
         LIMIT $4`,
        [
          this.allowedSchemas,
          allowedRelations,
          allowedColumnNames,
          MAX_RELATIONS * MAX_COLUMNS_PER_RELATION + 1
        ]
      );
      return result.rows;
    });

    const relations = new Map<string, CatalogRelation>();
    let truncated = rows.length > MAX_RELATIONS * MAX_COLUMNS_PER_RELATION;
    for (const row of rows.slice(0, MAX_RELATIONS * MAX_COLUMNS_PER_RELATION)) {
      const key = `${row.schema_name}.${row.relation_name}`;
      const policy = this.policies.get(key);
      if (
        !policy ||
        row.relation_kind !== "VIEW" ||
        !policy.columns.includes(row.column_name) ||
        !SAFE_IDENTIFIER.test(row.schema_name) ||
        !SAFE_IDENTIFIER.test(row.relation_name) ||
        BLOCKED_RELATION.test(row.relation_name) ||
        !SAFE_IDENTIFIER.test(row.column_name) ||
        BLOCKED_COLUMN.test(row.column_name) ||
        row.type_schema !== "pg_catalog" ||
        category(row.type_name) === "other"
      ) {
        continue;
      }
      let relation = relations.get(key);
      if (!relation) {
        if (relations.size >= MAX_RELATIONS) {
          truncated = true;
          continue;
        }
        relation = {
          schema: row.schema_name,
          name: row.relation_name,
          kind: "view",
          columns: new Map()
        };
        relations.set(key, relation);
      }
      if (relation.columns.size >= MAX_COLUMNS_PER_RELATION) {
        truncated = true;
        continue;
      }
      relation.columns.set(row.column_name, {
        name: row.column_name,
        dataType: sanitizeText(row.data_type, 80),
        typeName: row.type_name,
        category: category(row.type_name),
        nullable: row.is_nullable === "YES"
      });
    }
    for (const [key, relation] of relations) {
      const policy = this.policies.get(key)!;
      if (
        relation.columns.size !== policy.columns.length ||
        policy.columns.some((column) => !relation.columns.has(column))
      ) {
        relations.delete(key);
      }
    }
    return { relations, truncated };
  }
}
