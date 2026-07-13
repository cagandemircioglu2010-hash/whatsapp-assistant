import pino, { type Logger } from "pino";
import { sanitizeForLogs } from "../security/redact.js";

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "request.headers.authorization",
        "request.headers.cookie",
        "*.accessToken",
        "*.appSecret",
        "*.databaseUrl",
        "*.phone",
        "*.phoneNumber",
        "*.content",
        "*.text",
        "*.body",
        "*.rawBody"
      ],
      censor: "[REDACTED]"
    }
  });
}

export function logSafe(
  logger: Logger,
  level: "debug" | "info" | "warn" | "error",
  data: Record<string, unknown>,
  message: string
): void {
  logger[level](sanitizeForLogs(data) as Record<string, unknown>, message);
}
