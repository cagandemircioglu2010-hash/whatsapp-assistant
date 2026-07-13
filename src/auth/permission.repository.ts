import type { Pool } from "pg";
import type { PermissionAction } from "./types.js";

export interface PermissionLookup {
  has(userId: string, resource: string, action?: PermissionAction): Promise<boolean>;
}

export class PermissionRepository implements PermissionLookup {
  constructor(private readonly pool: Pool) {}

  async has(userId: string, resource: string, action: PermissionAction = "read"): Promise<boolean> {
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM permissions
         WHERE user_id = $1 AND resource = $2 AND action = $3
       ) AS allowed`,
      [userId, resource, action]
    );
    return result.rows[0]?.allowed ?? false;
  }
}
