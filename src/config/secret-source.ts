import { readFileSync, statSync } from "node:fs";

const MAX_SECRET_FILE_BYTES = 256 * 1024;

export function hydrateSecretFiles(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hydrated = { ...environment };
  const pairs = [
    ["DATA_ENCRYPTION_KEYS", "DATA_ENCRYPTION_KEYS_FILE"],
    ["IDENTIFIER_HASH_KEYS", "IDENTIFIER_HASH_KEYS_FILE"],
    ["AUDIT_INTEGRITY_KEYS", "AUDIT_INTEGRITY_KEYS_FILE"],
    ["DATABASE_CA_CERT", "DATABASE_CA_CERT_FILE"],
    ["COMPANY_DATABASE_CA_CERT", "COMPANY_DATABASE_CA_CERT_FILE"]
  ] as const;

  for (const [valueName, fileName] of pairs) {
    if (hydrated[valueName]?.trim() === "") delete hydrated[valueName];
    if (hydrated[fileName]?.trim() === "") delete hydrated[fileName];
    const inline = hydrated[valueName];
    const file = hydrated[fileName]?.trim();
    if (inline && file) throw new Error(`${valueName} and ${fileName} cannot both be set`);
    if (!file) continue;
    hydrated[fileName] = file;
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new Error(`${fileName} must reference a non-empty regular file smaller than 256 KiB`);
    }
    hydrated[valueName] = readFileSync(file, "utf8").trim();
  }
  return hydrated;
}
