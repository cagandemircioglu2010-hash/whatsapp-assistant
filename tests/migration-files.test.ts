import { describe, expect, it } from "vitest";
import {
  findMigrationsDirectory,
  readMigrationSql
} from "../src/db/migration-files.js";

describe("migration asset discovery", () => {
  it("finds SQL assets from both source and compiled module layouts", async () => {
    const sourceModule = new URL("../src/db/migrate.ts", import.meta.url).href;
    const compiledModule = new URL("../dist/src/db/migrate.js", import.meta.url).href;

    await expect(findMigrationsDirectory(sourceModule)).resolves.toMatch(/\/migrations\/?$/);
    await expect(findMigrationsDirectory(compiledModule)).resolves.toMatch(/\/migrations\/?$/);
  });

  it("reads migration SQL from the directory resolved for compiled output", async () => {
    const compiledModule = new URL("../dist/src/db/migrate.js", import.meta.url).href;
    const migrationsDirectory = await findMigrationsDirectory(compiledModule);

    await expect(
      readMigrationSql(migrationsDirectory, "001_identity_messages.sql")
    ).resolves.toContain("CREATE TABLE users");
  });
});
