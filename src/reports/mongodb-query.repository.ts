import type { Db, Document } from "mongodb";
import {
  BOUNDED_FILTER_OPERATORS,
  MAX_SCHEMA_RESULT_BYTES,
  compareReportingRelationNames,
  type ReportingRelationPolicy
} from "./schema-policy.js";
import {
  ReportingQueryError,
  reportingQueryInputSchema,
  reportingSchemaInputSchema,
  type ReportingQueries,
  type ReportingQueryInput,
  type ReportingQueryResult,
  type ReportingSchema,
  type ReportingSchemaInput
} from "./schema-query.repository.js";

const MAX_RESULT_BYTES = 16_000;
const MAX_CELL_CHARACTERS = 500;
type MongoFieldType = "string" | "number" | "date" | "boolean";

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
        throw new ReportingQueryError("query_overloaded", "Too many MongoDB queries are queued");
      }
      await new Promise<void>((resolve, reject) => {
        let waiter: { resolve: () => void; timer: NodeJS.Timeout };
        waiter = {
          resolve,
          timer: setTimeout(() => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(new ReportingQueryError("query_queue_timeout", "MongoDB query queue timed out"));
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
  if (value && typeof value === "object" && "_bsontype" in value) {
    const bson = value as { _bsontype?: unknown; toString?: () => string; valueOf?: () => unknown };
    if (bson._bsontype === "ObjectId" || bson._bsontype === "Binary") return "[identifier omitted]";
    const primitive = bson.valueOf?.();
    if (primitive !== value && ["string", "number", "boolean"].includes(typeof primitive)) {
      return normalizeCell(primitive);
    }
    return sanitizeText(bson.toString?.() ?? "[bson value]");
  }
  const serialized = JSON.stringify(value);
  return sanitizeText(serialized ?? String(value));
}

function getPath(document: Document, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new ReportingQueryError("invalid_query", `${label} contains duplicate entries`);
  }
}

function coerceValue(
  raw: string,
  type: MongoFieldType
): string | number | boolean | Date {
  switch (type) {
    case "number": {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
        throw new ReportingQueryError("invalid_filter", "Numeric filter value is invalid");
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || Math.abs(value) > 1e15) {
        throw new ReportingQueryError("invalid_filter", "Numeric filter value is outside the safe range");
      }
      return value;
    }
    case "boolean":
      if (raw !== "true" && raw !== "false") {
        throw new ReportingQueryError("invalid_filter", "Boolean filter value must be true or false");
      }
      return raw === "true";
    case "date": {
      const value = new Date(raw);
      if (Number.isNaN(value.getTime()) || raw.length > 40) {
        throw new ReportingQueryError("invalid_filter", "Date filter value is invalid");
      }
      return value;
    }
    case "string":
      return sanitizeText(raw);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateQuery(input: ReportingQueryInput, policy: ReportingRelationPolicy): void {
  if (input.columns.length === 0 && input.aggregates.length === 0) {
    throw new ReportingQueryError("invalid_query", "Select at least one field or aggregate");
  }
  unique(input.columns, "columns");
  unique(input.group_by, "group_by");
  unique(input.aggregates.map((aggregate) => aggregate.alias), "aggregate aliases");

  const approved = new Set(policy.columns);
  for (const field of [
    ...input.columns,
    ...input.group_by,
    ...input.filters.map((filter) => filter.column)
  ]) {
    if (!approved.has(field)) {
      throw new ReportingQueryError("unknown_column", "Requested MongoDB field is unavailable");
    }
  }
  for (const aggregate of input.aggregates) {
    if (input.columns.includes(aggregate.alias)) {
      throw new ReportingQueryError(
        "invalid_aggregate",
        "Aggregate aliases cannot duplicate selected fields"
      );
    }
    if (aggregate.function !== "count" && !aggregate.column) {
      throw new ReportingQueryError("invalid_aggregate", "Only count may omit its field");
    }
    if (aggregate.column && !approved.has(aggregate.column)) {
      throw new ReportingQueryError("unknown_column", "Aggregate field is unavailable");
    }
    const type = aggregate.column ? policy.fieldTypes?.[aggregate.column] : undefined;
    if ((aggregate.function === "sum" || aggregate.function === "avg") && type !== "number") {
      throw new ReportingQueryError("invalid_aggregate", "sum and avg require numeric fields");
    }
    if (
      (aggregate.function === "min" || aggregate.function === "max") &&
      type === "boolean"
    ) {
      throw new ReportingQueryError("invalid_aggregate", "min and max do not support boolean fields");
    }
  }
  if (input.aggregates.length > 0) {
    if (input.columns.some((column) => !input.group_by.includes(column))) {
      throw new ReportingQueryError("invalid_group", "Selected fields must be grouped");
    }
  } else if (input.group_by.length > 0) {
    throw new ReportingQueryError("invalid_group", "group_by requires an aggregate");
  }
  const orderTargets = new Set([
    ...input.columns,
    ...input.aggregates.map((aggregate) => aggregate.alias)
  ]);
  for (const order of input.order_by) {
    if (!orderTargets.has(order.target)) {
      throw new ReportingQueryError("invalid_order", "Order target must be selected");
    }
  }

  const approvedFilterColumns = new Set(policy.filterColumns);
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
      "This MongoDB relation requires an approved selective filter"
    );
  }
}

function compileFilter(input: ReportingQueryInput, policy: ReportingRelationPolicy): Document {
  const clauses: Document[] = [];
  for (const filter of input.filters) {
    const type = policy.fieldTypes?.[filter.column] as MongoFieldType;
    const nullOperator = filter.operator === "is_null" || filter.operator === "is_not_null";
    if (nullOperator) {
      if (filter.value !== null || filter.values.length > 0) {
        throw new ReportingQueryError("invalid_filter", "Null filters cannot include values");
      }
      clauses.push(
        filter.operator === "is_null"
          ? { [filter.column]: null }
          : { [filter.column]: { $ne: null, $exists: true } }
      );
      continue;
    }
    if (filter.operator === "in") {
      if (filter.value !== null || filter.values.length === 0) {
        throw new ReportingQueryError("invalid_filter", "The in operator requires values only");
      }
      clauses.push({
        [filter.column]: { $in: filter.values.map((value) => coerceValue(value, type)) }
      });
      continue;
    }
    if (filter.value === null || filter.values.length > 0) {
      throw new ReportingQueryError("invalid_filter", "This filter requires one value");
    }
    if ((filter.operator === "contains" || filter.operator === "starts_with") && type !== "string") {
      throw new ReportingQueryError("invalid_filter", "Text matching requires a string field");
    }
    const value = coerceValue(filter.value, type);
    switch (filter.operator) {
      case "eq":
        clauses.push({ [filter.column]: value });
        break;
      case "ne":
        clauses.push({ [filter.column]: { $ne: value } });
        break;
      case "lt":
        clauses.push({ [filter.column]: { $lt: value } });
        break;
      case "lte":
        clauses.push({ [filter.column]: { $lte: value } });
        break;
      case "gt":
        clauses.push({ [filter.column]: { $gt: value } });
        break;
      case "gte":
        clauses.push({ [filter.column]: { $gte: value } });
        break;
      case "contains":
        clauses.push({
          [filter.column]: { $regex: escapeRegex(String(value)), $options: "i" }
        });
        break;
      case "starts_with":
        clauses.push({
          [filter.column]: { $regex: `^${escapeRegex(String(value))}`, $options: "i" }
        });
        break;
    }
  }
  return clauses.length === 0 ? {} : clauses.length === 1 ? clauses[0]! : { $and: clauses };
}

function boundedRows(
  rawRows: readonly Document[],
  input: ReportingQueryInput,
  extractor: (row: Document, field: string, index: number) => unknown
): Pick<ReportingQueryResult, "rows" | "rowCount" | "truncated"> {
  let truncated = rawRows.length > input.limit;
  const fields = [...input.columns, ...input.aggregates.map((aggregate) => aggregate.alias)];
  const rows: Array<Record<string, unknown>> = [];
  for (const rawRow of rawRows.slice(0, input.limit)) {
    const normalized = Object.fromEntries(
      fields.map((field, index) => [sanitizeText(field, 128), normalizeCell(extractor(rawRow, field, index))])
    );
    const candidate = [...rows, normalized];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_RESULT_BYTES) {
      truncated = true;
      break;
    }
    rows.push(normalized);
  }
  return { rows, rowCount: rows.length, truncated };
}

export class MongoReportingQueryRepository implements ReportingQueries {
  private readonly policies: ReadonlyMap<string, ReportingRelationPolicy>;
  private readonly semaphore = new QuerySemaphore(2, 128, 2_000);

  constructor(
    private readonly database: Db,
    relationManifest: readonly ReportingRelationPolicy[],
    private readonly queryTimeoutMs = 2_000
  ) {
    if (
      relationManifest.length === 0 ||
      relationManifest.some((policy) => policy.source !== "mongodb")
    ) {
      throw new Error("MongoDB reporting requires at least one MongoDB relation policy");
    }
    if (
      relationManifest.some(
        (policy) =>
          !policy.collection ||
          !policy.description ||
          policy.columns.some(
            (column) =>
              policy.fieldTypes?.[column] === undefined ||
              policy.fieldDescriptions?.[column] === undefined
          )
      )
    ) {
      throw new Error(
        "MongoDB reporting policies require a collection plus relation and field metadata"
      );
    }
    this.policies = new Map(
      relationManifest.map((policy) => [
        policy.relation,
        {
          ...policy,
          columns: [...policy.columns],
          filterColumns: [...policy.filterColumns],
          fieldDescriptions: { ...(policy.fieldDescriptions ?? {}) },
          fieldTypes: { ...(policy.fieldTypes ?? {}) }
        }
      ])
    );
    if (this.policies.size !== relationManifest.length) {
      throw new Error("MongoDB relation policies must be unique");
    }
  }

  relationPolicies(): readonly ReportingRelationPolicy[] {
    return [...this.policies.values()];
  }

  async isReady(): Promise<boolean> {
    try {
      await this.database.command({ ping: 1 }, { timeoutMS: this.queryTimeoutMs });
      for (const policy of this.policies.values()) {
        const exists = await this.database
          .listCollections(
            { name: policy.collection! },
            { nameOnly: true, authorizedCollections: true }
          )
          .hasNext();
        if (!exists) return false;
      }
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
    const candidates = [...this.policies.values()]
      .filter((policy) => allowedRelations.has(policy.relation))
      .sort((left, right) => compareReportingRelationNames(left.relation, right.relation));
    const startIndex =
      input.cursor === null
        ? 0
        : candidates.findIndex((policy) => policy.relation === input.cursor) + 1;
    if (input.cursor !== null && startIndex === 0) {
      throw new ReportingQueryError("invalid_cursor", "Schema cursor is unavailable");
    }
    const relations: ReportingSchema["relations"] = [];
    let nextIndex = startIndex;
    for (; nextIndex < candidates.length; nextIndex += 1) {
      const policy = candidates[nextIndex]!;
      const candidate: ReportingSchema["relations"][number] = {
        name: policy.relation,
        source: "mongodb",
        ...(policy.description ? { description: policy.description } : {}),
        kind: "collection",
        columns: policy.columns.map((name) => ({
          name,
          dataType: policy.fieldTypes?.[name]!,
          nullable: true,
          ...(policy.fieldDescriptions?.[name]
            ? { description: policy.fieldDescriptions[name] }
            : {})
        })),
        queryPolicy: {
          requiresFilter: !policy.allowUnfiltered,
          filterColumns: [...policy.filterColumns],
          approvedOperators: policy.allowUnfiltered ? [] : [...BOUNDED_FILTER_OPERATORS]
        }
      };
      const page: ReportingSchema = {
        schemas: [...new Set([...relations, candidate].map((item) => item.name.split(".")[0]!))],
        relations: [...relations, candidate],
        limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
        truncated: nextIndex + 1 < candidates.length,
        nextCursor: nextIndex + 1 < candidates.length ? candidate.name : null
      };
      if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_SCHEMA_RESULT_BYTES) break;
      relations.push(candidate);
    }
    if (relations.length === 0 && startIndex < candidates.length) {
      throw new ReportingQueryError("schema_page_too_large", "Schema page cannot be represented safely");
    }
    const hasMore = nextIndex < candidates.length;
    return {
      schemas: [...new Set(relations.map((item) => item.name.split(".")[0]!))],
      relations,
      limits: { maxRows: 50, joinsSupported: false, rawSqlAccepted: false },
      truncated: hasMore,
      nextCursor: hasMore ? relations.at(-1)!.name : null
    };
  }

  async query(
    rawInput: ReportingQueryInput,
    allowedRelations: ReadonlySet<string> = new Set(this.policies.keys())
  ): Promise<ReportingQueryResult> {
    const input = reportingQueryInputSchema.parse(rawInput);
    const policy = this.policies.get(input.relation);
    if (!policy || !allowedRelations.has(input.relation)) {
      throw new ReportingQueryError("unknown_relation", "MongoDB relation is unavailable");
    }
    validateQuery(input, policy);
    const filter = compileFilter(input, policy);
    const collection = this.database.collection(policy.collection!);

    return this.semaphore.run(async () => {
      if (input.aggregates.length === 0) {
        const projection = Object.fromEntries([
          ["_id", 0],
          ...input.columns.map((column) => [column, 1])
        ]);
        const sort: Document = Object.fromEntries(
          input.order_by.map((order) => [order.target, order.direction === "asc" ? 1 : -1])
        );
        let cursor = collection.find(filter, {
          projection,
          maxTimeMS: this.queryTimeoutMs
        });
        if (input.order_by.length > 0) cursor = cursor.sort(sort);
        const rawRows = await cursor.limit(input.limit + 1).toArray();
        const bounded = boundedRows(rawRows, input, (row, field) => getPath(row, field));
        return {
          relation: input.relation,
          columns: [...input.columns],
          ...bounded
        };
      }

      const groupKeys = Object.fromEntries(
        input.group_by.map((field, index) => [`g${index}`, `$${field}`])
      );
      const aggregateStages: Document = Object.fromEntries(
        input.aggregates.map((aggregate, index) => {
          const argument = aggregate.column ? `$${aggregate.column}` : 1;
          const expression: Document =
            aggregate.function === "count"
              ? { $sum: 1 }
              : { [`$${aggregate.function}`]: argument };
          return [`a${index}`, expression];
        })
      );
      const project = Object.fromEntries([
        ["_id", 0],
        ...input.columns.map((field, index) => [`c${index}`, `$_id.g${input.group_by.indexOf(field)}`]),
        ...input.aggregates.map((_aggregate, index) => [`a${index}`, `$a${index}`])
      ]);
      const sortTargets = new Map<string, string>([
        ...input.columns.map((field, index) => [field, `c${index}`] as const),
        ...input.aggregates.map((aggregate, index) => [aggregate.alias, `a${index}`] as const)
      ]);
      const sort = Object.fromEntries(
        input.order_by.map((order) => [
          sortTargets.get(order.target)!,
          order.direction === "asc" ? 1 : -1
        ])
      );
      const pipeline: Document[] = [
        ...(Object.keys(filter).length > 0 ? [{ $match: filter }] : []),
        { $group: { _id: groupKeys, ...aggregateStages } },
        { $project: project },
        ...(input.order_by.length > 0 ? [{ $sort: sort }] : []),
        { $limit: input.limit + 1 }
      ];
      const rawRows = await collection
        .aggregate(pipeline, {
          allowDiskUse: false,
          maxTimeMS: this.queryTimeoutMs
        })
        .toArray();
      const bounded = boundedRows(rawRows, input, (row, _field, index) =>
        index < input.columns.length
          ? row[`c${index}`]
          : row[`a${index - input.columns.length}`]
      );
      return {
        relation: input.relation,
        columns: [...input.columns, ...input.aggregates.map((aggregate) => aggregate.alias)],
        ...bounded
      };
    });
  }
}
