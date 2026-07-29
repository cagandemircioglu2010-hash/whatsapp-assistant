import { describe, expect, it } from "vitest";
import { loadWhitelistAdminConfig } from "../src/admin/config.js";

const baseEnvironment = {
  NODE_ENV: "test",
  DATABASE_ADMIN_URL: "postgresql://owner:secret@localhost:5432/app",
  DATABASE_SSL_MODE: "disable",
  WHITELIST_ADMIN_PASSWORD: "test-password-".repeat(3)
};

describe("whitelist administration configuration", () => {
  it("loads an isolated admin database configuration", () => {
    expect(loadWhitelistAdminConfig(baseEnvironment)).toMatchObject({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3001,
      databaseUrl: baseEnvironment.DATABASE_ADMIN_URL,
      databaseTls: false,
      defaultPhoneCountry: "TR"
    });
  });

  it("requires a long password and verified TLS in production", () => {
    expect(() =>
      loadWhitelistAdminConfig({
        ...baseEnvironment,
        WHITELIST_ADMIN_PASSWORD: "short"
      })
    ).toThrow();
    expect(() =>
      loadWhitelistAdminConfig({
        ...baseEnvironment,
        NODE_ENV: "production"
      })
    ).toThrow("DATABASE_SSL_MODE must be verify-full");
    expect(() =>
      loadWhitelistAdminConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
        DATABASE_SSL_MODE: "verify-full",
        WHITELIST_ADMIN_PASSWORD: "a".repeat(32)
      })
    ).toThrow("too predictable");
  });
});
