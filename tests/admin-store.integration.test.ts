import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWhitelistAdminStore } from "../src/admin/store.js";
import { EnvelopeEncryption, parseDataEncryptionConfig } from "../src/security/encryption.js";
import { parseHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";

const db = new PGlite();
const encryption = new EnvelopeEncryption(
  parseDataEncryptionConfig(
    JSON.stringify({ current: Buffer.alloc(32, 21).toString("base64") }),
    "current"
  )
);
const identifiers = new VersionedHmac(
  parseHmacKeyRing(
    JSON.stringify({ current: Buffer.alloc(32, 22).toString("base64") }),
    "current"
  )
);
const auditIntegrity = new VersionedHmac(
  parseHmacKeyRing(
    JSON.stringify({ current: Buffer.alloc(32, 23).toString("base64") }),
    "current"
  )
);
const pool = {
  query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
  connect: async () => ({
    query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
    release: () => undefined
  })
} as unknown as Pool;
const store = new PostgresWhitelistAdminStore(
  pool,
  encryption,
  identifiers,
  auditIntegrity,
  "TR"
);

beforeAll(async () => {
  for (const filename of [
    "001_identity_messages.sql",
    "002_company_reporting.sql",
    "003_app_data_protection.sql",
    "004_identity_lifecycle.sql",
    "005_security_operations.sql",
    "006_finalize_security_controls.sql",
    "007_user_locale.sql"
  ]) {
    await db.exec(
      await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8")
    );
  }
  await store.assertReady();
});

afterAll(async () => {
  encryption.destroy();
  identifiers.destroy();
  auditIntegrity.destroy();
  await db.close();
});

describe("Postgres whitelist administration store", () => {
  it("creates, masks, updates, and deactivates users through audited transactions", async () => {
    const created = await store.upsertUser({
      phone: "0530 111 22 33",
      name: "Ada Tester",
      department: "Sales",
      role: "manager",
      locale: "tr",
      permissions: ["company.sales", "company.projects"]
    });
    expect(created).toEqual({ created: true });

    const initialUsers = await store.listUsers();
    expect(initialUsers).toHaveLength(1);
    expect(initialUsers[0]).toMatchObject({
      name: "Ada Tester",
      phoneMasked: "+905******233",
      department: "Sales",
      role: "manager",
      locale: "tr",
      active: true,
      permissions: ["company.projects", "company.sales"]
    });
    expect(JSON.stringify(initialUsers[0])).not.toContain("+905301112233");

    const updated = await store.upsertUser({
      phone: "+905301112233",
      name: "Ada Updated",
      role: "employee",
      locale: "en",
      permissions: []
    });
    expect(updated).toEqual({ created: false });

    const updatedUsers = await store.listUsers();
    expect(updatedUsers).toHaveLength(1);
    expect(updatedUsers[0]).toMatchObject({
      id: initialUsers[0]!.id,
      name: "Ada Updated",
      phoneMasked: "+905******233",
      department: null,
      role: "employee",
      locale: "en",
      active: true,
      permissions: []
    });

    await store.setUserActive(initialUsers[0]!.id, false);
    expect((await store.listUsers())[0]?.active).toBe(false);

    const audit = await db.query<{ event_type: string }>(
      `SELECT event_type
         FROM audit_events
        ORDER BY sequence`
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "identity.whitelist_update",
      "identity.whitelist_update",
      "identity.activation_update"
    ]);
  });

  it("rejects malformed user identifiers without querying", async () => {
    await expect(store.setUserActive("not-a-uuid", true)).rejects.toThrow(
      "User identifier is invalid"
    );
  });
});
