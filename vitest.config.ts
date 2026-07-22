import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30_000,
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/server.ts",
        "src/db/migrate.ts",
        "src/llm/openai-responses.gateway.ts",
        "src/mcp/stdio-server.ts",
        "src/**/types.ts"
      ],
      thresholds: {
        statements: 65,
        branches: 50,
        functions: 70,
        lines: 65
      }
    }
  }
});
