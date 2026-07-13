import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
  COMPANY_READONLY_DATABASE_URL: "postgresql://reader:pass@localhost:5432/company",
  PHONE_HASH_SECRET: "x".repeat(32),
  WHATSAPP_ENABLED: "false"
};

describe("application configuration", () => {
  it("requires an OpenAI key only when the LLM is enabled", () => {
    expect(() => loadConfig({ ...baseEnvironment, LLM_ENABLED: "true" })).toThrow("OPENAI_API_KEY");
    expect(
      loadConfig({ ...baseEnvironment, LLM_ENABLED: "true", OPENAI_API_KEY: "test-key" }).llm.enabled
    ).toBe(true);
    expect(loadConfig(baseEnvironment).llm.enabled).toBe(false);
  });
});
