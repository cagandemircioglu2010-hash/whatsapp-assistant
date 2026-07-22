import type { Pool } from "pg";
import type { PermissionAction } from "./types.js";

export interface PermissionLookup {
  has(userId: string, resource: string, action?: PermissionAction): Promise<boolean>;
  findAllowed?(
    userId: string,
    resources: readonly string[],
    action?: PermissionAction
  ): Promise<ReadonlySet<string>>;
}

export class PermissionRepository implements PermissionLookup {
  constructor(private readonly pool: Pool) {}

  async has(userId: string, resource: string, action: PermissionAction = "read"): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM permissions p
         JOIN users u ON u.id = p.user_id AND u.is_active = TRUE
         WHERE p.user_id = $1 AND p.resource = $2 AND p.action = $3
       ) AS allowed`,
      [userId, resource, action]
    );
    return result.rows[0]?.allowed ?? false;
  }

  async findAllowed(
    userId: string,
    resources: readonly string[],
    action: PermissionAction = "read"
  ): Promise<ReadonlySet<string>> {
    const uniqueResources = [...new Set(resources)];
    if (uniqueResources.length === 0) return new Set();
    const result = await this.pool.query<{ resource: string }>(
      `SELECT DISTINCT p.resource
       FROM permissions p
       JOIN users u ON u.id = p.user_id AND u.is_active = TRUE
       WHERE p.user_id = $1
         AND p.resource = ANY($2::text[])
         AND p.action = $3`,
      [userId, uniqueResources, action]
    );
    return new Set(result.rows.map((row) => row.resource));
  }
}
