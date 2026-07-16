import type { Pool } from "pg";
import type { AuthorizedUser } from "./types.js";
import type { EnvelopeEncryption } from "../security/encryption.js";
import type { VersionedHmac } from "../security/keyed-hash.js";

type UserRow = {
  id: string;
  department_ciphertext: string | null;
  role: string;
};

type UserIdentityRow = UserRow & {
  phone_ciphertext: string;
};

export type AuthorizedUserIdentity = {
  user: AuthorizedUser;
  phoneE164: string;
};

export interface UserLookup {
  findActiveByPhone(phoneE164: string): Promise<AuthorizedUser | null>;
}

export interface UserRecoveryLookup {
  findActiveIdentityById(userId: string): Promise<AuthorizedUserIdentity | null>;
}

export class UserRepository implements UserLookup {
  constructor(
    private readonly pool: Pool,
    private readonly identifiers: VersionedHmac,
    private readonly encryption: EnvelopeEncryption | null = null
  ) {}

  private decryptIdentityField(
    ciphertext: string | null,
    purpose: "users.full_name" | "users.department",
    userId: string
  ): string | null {
    if (!ciphertext) return null;
    if (!this.encryption) throw new Error("Encrypted user identity cannot be decrypted");
    return this.encryption.decrypt(ciphertext, purpose, `users:${userId}`);
  }

  private authorizedUser(row: UserRow): AuthorizedUser {
    return {
      id: row.id,
      department: this.decryptIdentityField(
        row.department_ciphertext,
        "users.department",
        row.id
      ),
      role: row.role
    };
  }

  async findActiveByPhone(phoneE164: string): Promise<AuthorizedUser | null> {
    const lookupHashes = this.identifiers
      .candidates(phoneE164, "phone-identifier")
      .map((candidate) => candidate.hash);
    const result = await this.pool.query<UserRow>(
      `SELECT id, department_ciphertext, role
       FROM users
       WHERE is_active = TRUE
         AND phone_lookup_hash::text = ANY($1::text[])
       LIMIT 1`,
      [lookupHashes]
    );
    const user = result.rows[0];
    if (!user) return null;

    return this.authorizedUser(user);
  }

  async findActiveIdentityById(userId: string): Promise<AuthorizedUserIdentity | null> {
    const result = await this.pool.query<UserIdentityRow>(
      `SELECT id, department_ciphertext, role, phone_ciphertext
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const phoneE164 = this.encryption?.decrypt(row.phone_ciphertext, "users.phone", `users:${row.id}`);
    if (!phoneE164) throw new Error("Active user phone identity cannot be decrypted");
    return {
      phoneE164,
      user: this.authorizedUser(row)
    };
  }
}
