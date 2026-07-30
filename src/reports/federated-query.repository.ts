import {
  MAX_SCHEMA_RESULT_BYTES,
  compareReportingRelationNames,
  type ReportingRelationPolicy
} from "./schema-policy.js";
import {
  ReportingQueryError,
  reportingSchemaInputSchema,
  type ReportingQueries,
  type ReportingQueryInput,
  type ReportingQueryResult,
  type ReportingSchema,
  type ReportingSchemaInput
} from "./schema-query.repository.js";

export class FederatedReportingQueryRepository implements ReportingQueries {
  private readonly policies: ReadonlyMap<string, ReportingRelationPolicy>;
  private readonly owners: ReadonlyMap<string, ReportingQueries>;

  constructor(private readonly providers: readonly ReportingQueries[]) {
    if (providers.length === 0) throw new Error("At least one reporting provider is required");
    const policies = new Map<string, ReportingRelationPolicy>();
    const owners = new Map<string, ReportingQueries>();
    for (const provider of providers) {
      for (const policy of provider.relationPolicies()) {
        if (policies.has(policy.relation)) {
          throw new Error(`Reporting relation is configured more than once: ${policy.relation}`);
        }
        policies.set(policy.relation, policy);
        owners.set(policy.relation, provider);
      }
    }
    this.policies = policies;
    this.owners = owners;
  }

  relationPolicies(): readonly ReportingRelationPolicy[] {
    return [...this.policies.values()];
  }

  async isReady(): Promise<boolean> {
    const readiness = await Promise.all(this.providers.map((provider) => provider.isReady()));
    return readiness.every(Boolean);
  }

  async discoverSchema(
    rawInput: ReportingSchemaInput = { cursor: null },
    allowedRelations: ReadonlySet<string> = new Set(this.policies.keys())
  ): Promise<ReportingSchema> {
    const input = reportingSchemaInputSchema.parse(rawInput);
    const discovered: ReportingSchema["relations"] = [];
    for (const provider of this.providers) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
        const page = await provider.discoverSchema({ cursor }, allowedRelations);
        discovered.push(...page.relations);
        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor)) {
          throw new ReportingQueryError("invalid_cursor", "Reporting provider repeated a schema cursor");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (pageIndex === 49) {
          throw new ReportingQueryError("schema_too_large", "Reporting schema has too many pages");
        }
      }
    }
    const candidates = discovered.sort((left, right) =>
      compareReportingRelationNames(left.name, right.name)
    );
    const startIndex =
      input.cursor === null
        ? 0
        : candidates.findIndex((relation) => relation.name === input.cursor) + 1;
    if (input.cursor !== null && startIndex === 0) {
      throw new ReportingQueryError("invalid_cursor", "Schema cursor is unavailable");
    }

    const relations: ReportingSchema["relations"] = [];
    let nextIndex = startIndex;
    for (; nextIndex < candidates.length; nextIndex += 1) {
      const candidate = candidates[nextIndex]!;
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
    input: ReportingQueryInput,
    allowedRelations: ReadonlySet<string> = new Set(this.policies.keys())
  ): Promise<ReportingQueryResult> {
    const owner = this.owners.get(input.relation);
    if (!owner || !allowedRelations.has(input.relation)) {
      throw new ReportingQueryError("unknown_relation", "Relation is unavailable");
    }
    return owner.query(input, allowedRelations);
  }
}
