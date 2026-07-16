import type { Pool } from "pg";
import type { AuthorizedUser } from "./types.js";
import { hashPhoneIdentifier } from "../security/phone.js";
import type { EnvelopeEncryption } from "../security/encryption.js";

type UserRow = {
  id: string;
  full_name: string | null;
  full_name_ciphertext: string | null;
  department: string | null;
  department_ciphertext: string | null;
  role: string;
};

type UserIdentityRow = UserRow & {
  phone_e164: string | null;
  phone_ciphertext: string | null;
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
    private readonly phoneHashSecret: string,
    private readonly encryption: EnvelopeEncryption | null = null
  ) {}

  private decryptIdentityField(
    plaintext: string | null,
    ciphertext: string | null,
    purpose: "users.full_name" | "users.department"
  ): string | null {
    if (!ciphertext) return plaintext;
    if (!this.encryption) throw new Error("Encrypted user identity cannot be decrypted");
    return this.encryption.decrypt(ciphertext, purpose);
  }

  private authorizedUser(row: UserRow): AuthorizedUser {
    const fullName = this.decryptIdentityField(
      row.full_name,
      row.full_name_ciphertext,
      "users.full_name"
    );
    if (!fullName) throw new Error("Active user name cannot be decrypted");
    return {
      id: row.id,
      fullName,
      department: this.decryptIdentityField(
        row.department,
        row.department_ciphertext,
        "users.department"
      ),
      role: row.role
    };
  }

  async findActiveByPhone(phoneE164: string): Promise<AuthorizedUser | null> {
    const lookupHash = hashPhoneIdentifier(phoneE164, this.phoneHashSecret);
    const result = await this.pool.query<UserRow>(
      `SELECT id, full_name, full_name_ciphertext, department, department_ciphertext, role
       FROM users
       WHERE is_active = TRUE
         AND (phone_lookup_hash = $1 OR (phone_lookup_hash IS NULL AND phone_e164 = $2))
       LIMIT 1`,
      [lookupHash, phoneE164]
    );
    const user = result.rows[0];
    if (!user) return null;

    return this.authorizedUser(user);
  }

  async findActiveIdentityById(userId: string): Promise<AuthorizedUserIdentity | null> {
    const result = await this.pool.query<UserIdentityRow>(
      `SELECT id, full_name, full_name_ciphertext, department, department_ciphertext,
              role, phone_e164, phone_ciphertext
       FROM users
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const phoneE164 = row.phone_ciphertext
      ? this.encryption?.decrypt(row.phone_ciphertext, "users.phone")
      : row.phone_e164;
    if (!phoneE164) throw new Error("Active user phone identity cannot be decrypted");
    return {
      phoneE164,
      user: this.authorizedUser(row)
    };
  }
}
