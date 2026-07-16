import { hydrateSecretFiles } from "../src/config/secret-source.js";
import { parseDataEncryptionConfig } from "../src/security/encryption.js";
import {
  legacyHmacKeyRing,
  parseHmacKeyRing,
  type HmacKeyRingConfig
} from "../src/security/keyed-hash.js";

function hmacRing(
  env: NodeJS.ProcessEnv,
  activeName: "IDENTIFIER_HASH_ACTIVE_KEY_ID" | "AUDIT_INTEGRITY_ACTIVE_KEY_ID",
  keysName: "IDENTIFIER_HASH_KEYS" | "AUDIT_INTEGRITY_KEYS",
  allowLegacy: boolean
): HmacKeyRingConfig {
  const active = env[activeName];
  const keys = env[keysName];
  if (active && keys) return parseHmacKeyRing(keys, active);
  if (active || keys) throw new Error(`${activeName} and ${keysName} must both be set`);
  if (allowLegacy && env.PHONE_HASH_SECRET) return legacyHmacKeyRing(env.PHONE_HASH_SECRET);
  throw new Error(`${activeName} and ${keysName} must be set`);
}

export function loadAdminSecurityConfig(options: { allowLegacyIdentifier?: boolean } = {}) {
  const env = hydrateSecretFiles(process.env);
  const activeEncryptionKeyId = env.DATA_ENCRYPTION_ACTIVE_KEY_ID;
  const encryptionKeys = env.DATA_ENCRYPTION_KEYS;
  if (!activeEncryptionKeyId || !encryptionKeys) throw new Error("Data encryption keys must be set");
  return {
    encryption: parseDataEncryptionConfig(encryptionKeys, activeEncryptionKeyId),
    identifiers: hmacRing(
      env,
      "IDENTIFIER_HASH_ACTIVE_KEY_ID",
      "IDENTIFIER_HASH_KEYS",
      options.allowLegacyIdentifier === true
    ),
    auditIntegrity: hmacRing(env, "AUDIT_INTEGRITY_ACTIVE_KEY_ID", "AUDIT_INTEGRITY_KEYS", false)
  };
}
