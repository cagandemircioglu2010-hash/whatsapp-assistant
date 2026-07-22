import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Render Blueprint security boundary", () => {
  it("never injects migration credentials into the web runtime", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");

    expect(blueprint).not.toMatch(/^\s*preDeployCommand:/m);
    expect(blueprint).not.toMatch(/^\s*- key: (?:COMPANY_)?DATABASE_ADMIN_URL$/m);
    expect(blueprint).not.toMatch(/^\s*- key: (?:POSTGRES|APP_RUNTIME|COMPANY_READONLY)_PASSWORD$/m);
    expect(blueprint).toMatch(/- key: DATABASE_SSL_MODE\s+value: verify-full/);
    expect(blueprint).toMatch(/- key: COMPANY_DATABASE_SSL_MODE\s+value: verify-full/);
  });
});
