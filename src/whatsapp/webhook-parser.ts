import type { IncomingWhatsAppMessage, WhatsAppMessageStatus, WhatsAppStatusError } from "./types.js";

type UnknownRecord = Record<string, unknown>;
const MAX_ITEMS_PER_LEVEL = 100;
const MAX_EVENTS_PER_PAYLOAD = 100;
const MAX_TEXT_LENGTH = 4096;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boundedArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS_PER_LEVEL) : [];
}

function safeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .slice(0, MAX_TEXT_LENGTH);
}

// Meta reports the reason a delivery failed inside statuses[].errors. Only the
// numeric code and a short sanitized title are kept, never nested payloads.
function extractStatusErrors(statusRecord: UnknownRecord): WhatsAppStatusError[] {
  const output: WhatsAppStatusError[] = [];
  for (const errorValue of boundedArray(statusRecord.errors).slice(0, 3)) {
    const errorRecord = record(errorValue);
    const code = errorRecord?.code;
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 99_999_999) continue;
    const title = string(errorRecord?.title);
    output.push({ code, title: title ? safeText(title).slice(0, 200) : null });
  }
  return output;
}

function validMessageId(value: string | null): value is string {
  return Boolean(value && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value));
}

function extractText(message: UnknownRecord, type: string): string {
  if (type === "text") return safeText(string(record(message.text)?.body) ?? "");
  if (type === "button") return safeText(string(record(message.button)?.text) ?? "");
  if (type === "interactive") {
    const interactive = record(message.interactive);
    return safeText(
      string(record(interactive?.button_reply)?.title) ??
      string(record(interactive?.list_reply)?.title) ??
      ""
    );
  }
  return `[${type}]`;
}

export function parseIncomingMessages(
  payload: unknown,
  expectedPhoneNumberId?: string
): IncomingWhatsAppMessage[] {
  const root = record(payload);
  if (expectedPhoneNumberId && string(root?.object) !== "whatsapp_business_account") return [];
  const entries = boundedArray(root?.entry);
  const output: IncomingWhatsAppMessage[] = [];
  const seenMessageIds = new Set<string>();
  let inspectedEvents = 0;

  for (const entryValue of entries) {
    const entry = record(entryValue);
    const changes = boundedArray(entry?.changes);
    for (const changeValue of changes) {
      const value = record(record(changeValue)?.value);
      if (
        expectedPhoneNumberId &&
        string(record(value?.metadata)?.phone_number_id) !== expectedPhoneNumberId
      ) {
        continue;
      }
      const messages = boundedArray(value?.messages);
      for (const messageValue of messages) {
        inspectedEvents += 1;
        if (inspectedEvents > MAX_EVENTS_PER_PAYLOAD) return output;
        const message = record(messageValue);
        if (!message) continue;
        const externalMessageId = string(message.id);
        const from = string(message.from);
        const type = string(message.type) ?? "unknown";
        const timestamp = string(message.timestamp) ?? "";
        if (
          !validMessageId(externalMessageId) ||
          seenMessageIds.has(externalMessageId) ||
          !from ||
          !/^\d{7,20}$/.test(from) ||
          !/^[a-z0-9_]{1,32}$/i.test(type) ||
          (timestamp && !/^\d{1,16}$/.test(timestamp))
        ) {
          continue;
        }
        seenMessageIds.add(externalMessageId);
        output.push({
          externalMessageId,
          from,
          type,
          text: extractText(message, type),
          timestamp
        });
        if (output.length >= MAX_EVENTS_PER_PAYLOAD) return output;
      }
    }
  }
  return output;
}

export function parseMessageStatusUpdates(
  payload: unknown,
  expectedPhoneNumberId?: string
): WhatsAppMessageStatus[] {
  const root = record(payload);
  if (expectedPhoneNumberId && string(root?.object) !== "whatsapp_business_account") return [];
  const output: WhatsAppMessageStatus[] = [];
  const seen = new Set<string>();
  let inspectedEvents = 0;
  const allowedStatuses = new Set<WhatsAppMessageStatus["status"]>([
    "sent",
    "delivered",
    "read",
    "failed"
  ]);

  for (const entryValue of boundedArray(root?.entry)) {
    const entry = record(entryValue);
    for (const changeValue of boundedArray(entry?.changes)) {
      const value = record(record(changeValue)?.value);
      if (
        expectedPhoneNumberId &&
        string(record(value?.metadata)?.phone_number_id) !== expectedPhoneNumberId
      ) {
        continue;
      }
      for (const statusValue of boundedArray(value?.statuses)) {
        inspectedEvents += 1;
        if (inspectedEvents > MAX_EVENTS_PER_PAYLOAD) return output;
        const statusRecord = record(statusValue);
        if (!statusRecord) continue;
        const externalMessageId = string(statusRecord.id);
        const status = string(statusRecord.status) as WhatsAppMessageStatus["status"] | null;
        const timestamp = string(statusRecord.timestamp) ?? "";
        const deduplicationKey = `${externalMessageId ?? ""}:${status ?? ""}`;
        if (
          !validMessageId(externalMessageId) ||
          !status ||
          !allowedStatuses.has(status) ||
          (timestamp && !/^\d{1,16}$/.test(timestamp)) ||
          seen.has(deduplicationKey)
        ) {
          continue;
        }
        seen.add(deduplicationKey);
        const errors = status === "failed" ? extractStatusErrors(statusRecord) : [];
        output.push({
          externalMessageId,
          status,
          timestamp,
          ...(errors.length > 0 ? { errors } : {})
        });
        if (output.length >= MAX_EVENTS_PER_PAYLOAD) return output;
      }
    }
  }
  return output;
}
