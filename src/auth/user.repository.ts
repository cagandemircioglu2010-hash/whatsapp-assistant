import type { Pool } from "pg";
import type { AuthorizedUser } from "./types.js";

type UserRow = {
  id: string;
  full_name: string;
  department: string | null;
  role: string;
};

export interface UserLookup {
  findActiveByPhone(phoneE164: string): Promise<AuthorizedUser | null>;
}

export class UserRepository implements UserLookup {
  constructor(private readonly pool: Pool) {}

  async findActiveByPhone(phoneE164: string): Promise<AuthorizedUser | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, full_name, department, role
       FROM users
       WHERE phone_e164 = $1 AND is_active = TRUE
       LIMIT 1`,
      [phoneE164]
    );
    const user = result.rows[0];
    if (!user) return null;

    return {
      id: user.id,
      fullName: user.full_name,
      department: user.department,
      role: user.role
    };
  }
}
