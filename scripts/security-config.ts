import { loadAdminSecurityConfig as loadSecurityConfig } from "../src/admin/security-config.js";

export function loadAdminSecurityConfig(
  options: { allowLegacyIdentifier?: boolean } = {}
) {
  return loadSecurityConfig(process.env, options);
}
