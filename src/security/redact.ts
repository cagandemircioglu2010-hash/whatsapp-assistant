const REDACTED = "[REDACTED]";

const sensitiveKeys = new Set([
  "password",
  "passwd",
  "secret",
  "appsecret",
  "metaappsecret",
  "phonehashsecret",
  "dataencryptionkeys",
  "dataencryptionactivekeyid",
  "token",
  "verifytoken",
  "accesstoken",
  "authorization",
  "cookie",
  "apikey",
  "databaseurl",
  "companyreadonlydatabaseurl",
  "phone",
  "phonenumber",
  "phonee164",
  "email",
  "content",
  "text",
  "body",
  "rawbody"
]);

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const providerTokenPattern =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|EAA[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;
const databaseUrlPattern = /postgres(?:ql)?:\/\/[^\s]+/gi;
const phonePattern = /(?<!\w)\+?\d[\d\s().-]{8,}\d(?!\w)/g;

function normalizedKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    /(password|passwd|secret|token|apikey|authorization|cookie)/.test(normalized) ||
    normalized.endsWith("databaseurl")
  );
}

export function redactString(value: string): string {
  return value
    .replace(databaseUrlPattern, REDACTED)
    .replace(bearerPattern, REDACTED)
    .replace(providerTokenPattern, REDACTED)
    .replace(emailPattern, REDACTED)
    .replace(phonePattern, REDACTED);
}

export function sanitizeForLogs(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[REDACTED_BINARY]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: process.env.NODE_ENV === "production" ? undefined : value.stack ? redactString(value.stack) : undefined
    };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLogs(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLogs(item, seen);
  }
  return output;
}
