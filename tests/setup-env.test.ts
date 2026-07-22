import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("Render environment generator", () => {
  it("omits every admin and provisioning credential from runtime output", async () => {
    const script = fileURLToPath(new URL("../scripts/setup-env.ts", import.meta.url));
    const { stdout } = await execute(process.execPath, ["--import", "tsx", script, "--render"], {
      maxBuffer: 1_000_000
    });
    const keys = new Set(
      stdout
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => line.slice(0, line.indexOf("=")))
    );

    for (const forbidden of [
      "POSTGRES_PASSWORD",
      "DATABASE_ADMIN_URL",
      "COMPANY_DATABASE_ADMIN_URL",
      "APP_RUNTIME_USER",
      "APP_RUNTIME_PASSWORD",
      "COMPANY_READONLY_USER",
      "COMPANY_READONLY_PASSWORD"
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(keys.has("DATABASE_URL")).toBe(true);
    expect(keys.has("COMPANY_READONLY_DATABASE_URL")).toBe(true);
    expect(keys.has("LLM_SCHEMA_RELATION_MANIFEST")).toBe(true);
  });
});
