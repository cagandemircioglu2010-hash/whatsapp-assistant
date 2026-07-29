import type { CountryCode } from "libphonenumber-js";
import type { Pool } from "pg";
import { ensureSecurityCanary } from "../db/readiness.js";
import { appendAuditEvent } from "../messages/audit.repository.js";
import type { EnvelopeEncryption } from "../security/encryption.js";
import type { VersionedHmac } from "../security/keyed-hash.js";
import {
  normalizeWhitelistUser,
  upsertWhitelistedUser,
  type WhitelistCrypto,
  type WhitelistUserInput
} from "../../scripts/whitelist-user.js";
import type {
  AdminUpsertResult,
  AdminWhitelistUser,
  WhitelistAdminStore
} from "./types.js";

type StoredUser = {
  id: string;
  role: string;
  locale: "tr" | "en" | null;
  is_active: boolean;
  created_at: Date;
  phone_ciphertext: string | null;
  full_name_ciphertext: string | null;
  department_ciphertext: string | null;
  permissions: string[] | null;
};

function maskPhone(phone: string): string {
  return phone.length > 7
    ? `${phone.slice(0, 4)}${"*".repeat(phone.length - 7)}${phone.slice(-3)}`
    : "***";
}

function decryptRequired(
  encryption: EnvelopeEncryption,
  ciphertext: string | null,
  purpose: "users.phone" | "users.full_name",
  binding: string
): string {
  if (!ciphertext) throw new Error("Stored user identity is incomplete");
  return encryption.decrypt(ciphertext, purpose, binding);
}

export class PostgresWhitelistAdminStore implements WhitelistAdminStore {
  private readonly crypto: WhitelistCrypto;

  constructor(
    private readonly pool: Pool,
    encryption: EnvelopeEncryption,
    identifiers: VersionedHmac,
    auditIntegrity: VersionedHmac,
    private readonly defaultCountry: CountryCode
  ) {
    this.crypto = { encryption, identifiers, auditIntegrity };
  }

  async assertReady(): Promise<void> {
    await ensureSecurityCanary(
      this.pool,
      this.crypto.encryption,
      this.crypto.identifiers,
      this.crypto.auditIntegrity
    );
  }

  async listUsers(): Promise<AdminWhitelistUser[]> {
    const result = await this.pool.query<StoredUser>(
      `SELECT u.id, u.role, u.locale, u.is_active, u.created_at,
              u.phone_ciphertext, u.full_name_ciphertext, u.department_ciphertext,
              ARRAY_AGG(p.resource ORDER BY p.resource)
                FILTER (WHERE p.resource IS NOT NULL AND p.action = 'read') AS permissions
         FROM users u
         LEFT JOIN permissions p ON p.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT 500`
    );

    return result.rows.map((row) => {
      const binding = `users:${row.id}`;
      const phone = decryptRequired(
        this.crypto.encryption,
        row.phone_ciphertext,
        "users.phone",
        binding
      );
      const name = decryptRequired(
        this.crypto.encryption,
        row.full_name_ciphertext,
        "users.full_name",
        binding
      );
      const department = row.department_ciphertext
        ? this.crypto.encryption.decrypt(
            row.department_ciphertext,
            "users.department",
            binding
          )
        : null;
      return {
        id: row.id,
        name,
        phoneMasked: maskPhone(phone),
        department,
        role: row.role,
        locale: row.locale,
        active: row.is_active,
        permissions: row.permissions ?? [],
        createdAt: row.created_at
      };
    });
  }

  async upsertUser(input: WhitelistUserInput): Promise<AdminUpsertResult> {
    const user = normalizeWhitelistUser(input, this.defaultCountry);
    const client = await this.pool.connect();
    try {
      await ensureSecurityCanary(
        client,
        this.crypto.encryption,
        this.crypto.identifiers,
        this.crypto.auditIntegrity
      );
      await client.query("BEGIN");
      const result = await upsertWhitelistedUser(client, this.crypto, user);
      await client.query("COMMIT");
      return { created: result.created };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error("User identifier is invalid");
    }
    const client = await this.pool.connect();
    try {
      await ensureSecurityCanary(
        client,
        this.crypto.encryption,
        this.crypto.identifiers,
        this.crypto.auditIntegrity
      );
      await client.query("BEGIN");
      const updated = await client.query<{ id: string }>(
        `UPDATE users
            SET is_active = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING id`,
        [userId, active]
      );
      if (!updated.rows[0]) throw new Error("Whitelist user was not found");
      await appendAuditEvent(client, this.crypto.auditIntegrity, {
        userId,
        eventType: "identity.activation_update",
        outcome: "success",
        details: { active }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
    this.crypto.encryption.destroy();
    this.crypto.identifiers.destroy();
    this.crypto.auditIntegrity.destroy();
  }
}
