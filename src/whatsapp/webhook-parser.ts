import type { IncomingWhatsAppMessage } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractText(message: UnknownRecord, type: string): string {
  if (type === "text") return string(record(message.text)?.body) ?? "";
  if (type === "button") return string(record(message.button)?.text) ?? "";
  if (type === "interactive") {
    const interactive = record(message.interactive);
    return (
      string(record(interactive?.button_reply)?.title) ??
      string(record(interactive?.list_reply)?.title) ??
      ""
    );
  }
  return `[${type}]`;
}

export function parseIncomingMessages(payload: unknown): IncomingWhatsAppMessage[] {
  const root = record(payload);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  const output: IncomingWhatsAppMessage[] = [];

  for (const entryValue of entries) {
    const entry = record(entryValue);
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const changeValue of changes) {
      const value = record(record(changeValue)?.value);
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const messageValue of messages) {
        const message = record(messageValue);
        if (!message) continue;
        const externalMessageId = string(message.id);
        const from = string(message.from);
        const type = string(message.type) ?? "unknown";
        const timestamp = string(message.timestamp) ?? "";
        if (!externalMessageId || !from) continue;
        output.push({
          externalMessageId,
          from,
          type,
          text: extractText(message, type),
          timestamp
        });
      }
    }
  }
  return output;
}
