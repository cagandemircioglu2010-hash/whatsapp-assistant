import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationFilename = /^\d+_[a-z0-9_]+\.sql$/;

export async function findMigrationsDirectory(moduleUrl: string): Promise<string> {
  const candidates = [
    fileURLToPath(new URL("../../migrations/", moduleUrl)),
    fileURLToPath(new URL("../../../migrations/", moduleUrl))
  ];
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate);
      if (entries.some((filename) => migrationFilename.test(filename))) return candidate;
    } catch {
      // Try the compiled-layout fallback below.
    }
  }
  throw new Error("Migrations directory could not be located");
}

export async function readMigrationSql(
  migrationsDirectory: string,
  filename: string
): Promise<string> {
  if (!migrationFilename.test(filename)) throw new Error("Migration filename is invalid");
  return readFile(join(migrationsDirectory, filename), "utf8");
}
