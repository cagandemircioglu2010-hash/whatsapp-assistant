import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CountryCode } from "libphonenumber-js";
import { reportResources } from "../src/auth/types.js";
import { appendAuditEvent } from "../src/messages/audit.repository.js";
import type { EnvelopeEncryption } from "../src/security/encryption.js";
import type { VersionedHmac } from "../src/security/keyed-hash.js";
import { normalizePhoneNumber } from "../src/security/phone.js";

// Shared whitelist upsert used by both `db:add-user` (single) and
// `db:whitelist-batch` (many). Keeping one implementation means the encryption,
// hashing, permission reconciliation, and audit chaining stay identical no
// matter how a user is onboarded.

export type WhitelistUserInput = {
  phone: string;
  name: string;
  department?: string | null | undefined;
  role?: string | undefined;
  locale?: string | null | undefined;
  permissions?: string[] | undefined;
};

export type NormalizedWhitelistUser = {
  phoneE164: string;
  name: string;
  department: string | null;
  role: string;
  locale: "tr" | "en" | null;
  permissions: string[];
};

export type WhitelistCrypto = {
  encryption: EnvelopeEncryption;
  identifiers: VersionedHmac;
  auditIntegrity: VersionedHmac;
};

const allowedResources = new Set<string>(Object.values(reportResources));
const allowedRoles = new Set(["employee", "manager", "executive", "admin"]);

// Validates and normalizes one record. `label` is woven into error messages so
// a failing row in a batch is identifiable (e.g. "row 3 (\"+90...\")").
export function normalizeWhitelistUser(
  input: WhitelistUserInput,
  defaultCountry: CountryCode,
  label = "user"
): NormalizedWhitelistUser {
  const phoneE164 = normalizePhoneNumber(input.phone, defaultCountry);
  if (!phoneE164) throw new Error(`${label}: phone number is not valid`);
  const name = input.name?.trim() ?? "";
  if (name.length < 2 || name.length > 120) throw new Error(`${label}: name must be 2-120 characters`);
  const department = input.department?.trim() || null;
  if (department && department.length > 100) throw new Error(`${label}: department must not exceed 100 characters`);
  const role = input.role ?? "employee";
  if (!allowedRoles.has(role)) throw new Error(`${label}: role must be employee, manager, executive, or admin`);
  const locale = input.locale ?? null;
  if (locale !== null && locale !== "tr" && locale !== "en") throw new Error(`${label}: locale must be tr or en`);
  const permissions = (input.permissions ?? []).map((value) => value.trim()).filter(Boolean);
  const invalid = permissions.find((resource) => !allowedResources.has(resource));
  if (invalid) throw new Error(`${label}: permission "${invalid}" must be one of ${[...allowedResources].join(", ")}`);
  return { phoneE164, name, department, role, locale, permissions };
}

export async function upsertWhitelistedUser(
  client: Pick<PoolClient, "query">,
  crypto: WhitelistCrypto,
  user: NormalizedWhitelistUser
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users
     WHERE phone_lookup_hash::text = ANY($1::text[])
     LIMIT 1
     FOR UPDATE`,
    [crypto.identifiers.candidates(user.phoneE164, "phone-identifier").map((candidate) => candidate.hash)]
  );
  const existingId = existing.rows[0]?.id ?? randomUUID();
  const binding = `users:${existingId}`;
  const phoneLookup = crypto.identifiers.hash(user.phoneE164, "phone-identifier");
  const protectedPhone = crypto.encryption.encrypt(user.phoneE164, "users.phone", binding);
  const protectedFullName = crypto.encryption.encrypt(user.name, "users.full_name", binding);
  const protectedDepartment = user.department
    ? crypto.encryption.encrypt(user.department, "users.department", binding)
    : null;
  const parameters = [
    existingId,
    phoneLookup.hash,
    phoneLookup.keyId,
    protectedPhone.ciphertext,
    protectedPhone.keyId,
    protectedFullName.ciphertext,
    protectedFullName.keyId,
    protectedDepartment?.ciphertext ?? null,
    protectedDepartment?.keyId ?? null,
    user.role,
    user.locale
  ];
  const userResult = existing.rows[0]
    ? await client.query<{ id: string }>(
        `UPDATE users
         SET phone_lookup_hash = $2, phone_lookup_key_id = $3,
             phone_ciphertext = $4, phone_key_id = $5,
             full_name_ciphertext = $6, full_name_key_id = $7,
             department_ciphertext = $8, department_key_id = $9,
             role = $10, locale = $11, is_active = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        parameters
      )
    : await client.query<{ id: string }>(
        `INSERT INTO users (
           id, phone_lookup_hash, phone_lookup_key_id, phone_ciphertext, phone_key_id,
           full_name_ciphertext, full_name_key_id,
           department_ciphertext, department_key_id,
           role, locale, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE)
         RETURNING id`,
        parameters
      );
  const userId = userResult.rows[0]?.id;
  if (!userId) throw new Error("User could not be created");

  for (const resource of user.permissions) {
    await client.query(
      `INSERT INTO permissions (user_id, resource, action)
       VALUES ($1, $2, 'read')
       ON CONFLICT (user_id, resource, action) DO NOTHING`,
      [userId, resource]
    );
  }
  await client.query(
    `DELETE FROM permissions
     WHERE user_id = $1
       AND NOT (action = 'read' AND resource = ANY($2::text[]))`,
    [userId, user.permissions]
  );
  await appendAuditEvent(client, crypto.auditIntegrity, {
    userId,
    eventType: "identity.whitelist_update",
    outcome: "success",
    details: { resources: user.permissions }
  });
  return { id: userId, created: !existing.rows[0] };
}
