import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PermissionRepository } from "../src/auth/permission.repository.js";

describe("permission repository", () => {
  it("requires an active user and batches requested resources", async () => {
    const calls: Array<{ sql: string; parameters: unknown[] }> = [];
    const pool = {
      query: async (sql: string, parameters: unknown[]) => {
        calls.push({ sql, parameters });
        return sql.includes("SELECT DISTINCT")
          ? { rows: [{ resource: "company.projects" }] }
          : { rows: [{ allowed: true }] };
      }
    } as unknown as Pool;
    const repository = new PermissionRepository(pool);

    await expect(repository.has("user-1", "company.projects")).resolves.toBe(true);
    await expect(
      repository.findAllowed("user-1", ["company.projects", "company.projects", "company.tasks"])
    ).resolves.toEqual(new Set(["company.projects"]));

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.sql.includes("u.is_active = TRUE"))).toBe(true);
    expect(calls[1]?.parameters).toEqual([
      "user-1",
      ["company.projects", "company.tasks"],
      "read"
    ]);
  });

  it("does not query for an empty resource batch", async () => {
    let calls = 0;
    const repository = new PermissionRepository({
      query: async () => {
        calls += 1;
        return { rows: [] };
      }
    } as unknown as Pool);

    await expect(repository.findAllowed("user-1", [])).resolves.toEqual(new Set());
    expect(calls).toBe(0);
  });
});
