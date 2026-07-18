import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../src/auth/authorization.service.js";
import type { PermissionLookup } from "../src/auth/permission.repository.js";
import type { UserLookup } from "../src/auth/user.repository.js";
import { createLogger } from "../src/logging/logger.js";
import type { AuditInput, AuditStore } from "../src/messages/audit.repository.js";
import { MessageProcessor } from "../src/messages/message-processor.js";
import type {
  InboundMessageRecord,
  MessageStore,
  SaveInboundInput,
  SaveOutboundInput
} from "../src/messages/message.repository.js";
import type { CompanyReports } from "../src/reports/company-report.repository.js";
import { ReportCommandRouter } from "../src/reports/report-command-router.js";
import { legacyHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import { InMemoryRateLimitStore } from "../src/security/rate-limiter.js";
import { sanitizeForLogs } from "../src/security/redact.js";
import {
  isPermanentSendError,
  splitWhatsAppText,
  WhatsAppApiError,
  WhatsAppClient,
  WhatsAppSendValidationError
} from "../src/whatsapp/client.js";
import { classifyMetaError, metaErrorHint } from "../src/whatsapp/meta-errors.js";
import { parseMessageStatusUpdates } from "../src/whatsapp/webhook-parser.js";
import type { WhatsAppSender } from "../src/whatsapp/types.js";

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function client(fetchFn: typeof fetch): WhatsAppClient {
  return new WhatsAppClient({
    accessToken: "x".repeat(30),
    phoneNumberId: "123456789",
    graphApiVersion: "v25.0",
    fetchFn,
    sleep: async () => undefined
  });
}

describe("WhatsApp API error diagnostics", () => {
  it("parses the Meta error body into a typed permanent error with a hint", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response(400, {
        error: {
          message: "(#131030) Recipient phone number not in allowed list",
          type: "OAuthException",
          code: 131030,
          error_subcode: 2655007,
          fbtrace_id: "AbCdEf123"
        }
      })
    );

    const failure = await client(fetchFn)
      .sendText("905551234567", "Durum")
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WhatsAppApiError);
    const apiError = failure as WhatsAppApiError;
    expect(apiError.loggableDetails).toMatchObject({
      httpStatus: 400,
      metaErrorCode: 131030,
      metaErrorSubcode: 2655007,
      fbtraceId: "AbCdEf123",
      classification: "permanent"
    });
    expect(apiError.loggableDetails.hint).toContain("allowed");
    expect(apiError.permanent).toBe(true);
    expect(isPermanentSendError(apiError)).toBe(true);
  });

  it("classifies an expired token (190) as permanent and throttling (80007) as retryable", () => {
    expect(classifyMetaError(190, 401)).toBe("permanent");
    expect(classifyMetaError(80007, 429)).toBe("retryable");
    expect(classifyMetaError(null, 400)).toBe("permanent");
    expect(metaErrorHint(190, 401)).toContain("token");
    expect(metaErrorHint(131030, 400)).toContain("allowed");
  });

  it("scrubs phone numbers out of the captured Meta error message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response(400, {
        error: { message: "Recipient +905551234567 rejected", code: 131030 }
      })
    );
    const failure = (await client(fetchFn)
      .sendText("905551234567", "Durum")
      .then(() => null, (error: unknown) => error)) as WhatsAppApiError;
    expect(failure.loggableDetails.apiMessage).not.toContain("905551234567");
    expect(failure.loggableDetails.apiMessage).toContain("[REDACTED]");
  });

  it("keeps structured details visible through the production log sanitizer", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const error = new WhatsAppApiError({
        httpStatus: 400,
        metaErrorCode: 131030,
        metaErrorSubcode: null,
        fbtraceId: "trace-1",
        apiMessage: "[REDACTED]",
        hint: metaErrorHint(131030, 400),
        classification: "permanent"
      });
      const sanitized = sanitizeForLogs({ error }) as { error: Record<string, unknown> };
      expect(sanitized.error.message).toBe("[REDACTED]");
      expect(sanitized.error.details).toMatchObject({
        httpStatus: 400,
        metaErrorCode: 131030,
        classification: "permanent"
      });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("rejects empty and absurdly long texts as permanent validation errors", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(client(fetchFn).sendText("905551234567", "   ")).rejects.toBeInstanceOf(
      WhatsAppSendValidationError
    );
    await expect(client(fetchFn).sendText("905551234567", "x".repeat(40_000))).rejects.toBeInstanceOf(
      WhatsAppSendValidationError
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("long reply chunking", () => {
  it("splits on natural boundaries and keeps every chunk under the limit", () => {
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)} ${"c".repeat(2000)}`;
    const chunks = splitWhatsAppText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(chunks.join("")).toContain("a".repeat(3000));
  });

  it("sends each chunk as a separate message and returns the last id", async () => {
    let counter = 0;
    const fetchFn = vi.fn<typeof fetch>(async () => {
      counter += 1;
      return response(200, { messages: [{ id: `wamid.chunk.${counter}` }] });
    });
    const result = await client(fetchFn).sendText("905551234567", `${"x".repeat(5000)} ${"y".repeat(2000)}`);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.externalMessageId).toBe("wamid.chunk.2");
  });
});

describe("delivery status error parsing", () => {
  it("captures bounded error codes and titles from failed statuses", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "123456789" },
            statuses: [{
              id: "wamid.out",
              status: "failed",
              timestamp: "1700000000",
              errors: [
                { code: 131026, title: "Message undeliverable", href: "https://example.invalid" },
                { code: "not-a-number", title: "ignored" },
                { code: 190, title: "x".repeat(500) }
              ]
            }]
          }
        }]
      }]
    };
    const updates = parseMessageStatusUpdates(payload, "123456789");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.errors).toEqual([
      { code: 131026, title: "Message undeliverable" },
      { code: 190, title: "x".repeat(200) }
    ]);
  });

  it("omits errors for successful statuses", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "123456789" },
            statuses: [{ id: "wamid.out", status: "delivered", errors: [{ code: 1 }] }]
          }
        }]
      }]
    };
    const updates = parseMessageStatusUpdates(payload, "123456789");
    expect(updates[0]?.errors).toBeUndefined();
  });
});

class MemoryMessages implements MessageStore {
  statuses: string[] = [];
  undeliverable: string[] = [];
  outbound: SaveOutboundInput[] = [];
  async saveInbound(_input: SaveInboundInput): Promise<InboundMessageRecord> {
    return { id: "message-db-1", status: "received", processingAttempts: 0 };
  }
  async claimInbound(): Promise<boolean> {
    return true;
  }
  async setInboundStatus(_messageId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    this.statuses.push(status);
  }
  async markInboundUndeliverable(messageId: string): Promise<void> {
    this.undeliverable.push(messageId);
  }
  async saveOutbound(input: SaveOutboundInput): Promise<string> {
    this.outbound.push(input);
    return "message-db-2";
  }
}

class MemoryAudit implements AuditStore {
  events: AuditInput[] = [];
  async record(input: AuditInput): Promise<void> {
    this.events.push(input);
  }
}

const permissions: PermissionLookup = { has: async () => true };
const reports: CompanyReports = {
  getSalesSummary: async (input) => ({ ...input, currencies: [], generatedAt: new Date().toISOString() }),
  getActiveProjects: async () => [],
  getOverdueTasks: async () => []
};
const users: UserLookup = {
  findActiveByPhone: async () => ({ id: "user-1", department: "Sales", role: "employee" })
};

function buildProcessor(messages: MemoryMessages, audit: MemoryAudit, sender: WhatsAppSender) {
  return new MessageProcessor({
    users,
    messages,
    audit,
    sender,
    router: new ReportCommandRouter(reports, new AuthorizationService(permissions), "Europe/Istanbul"),
    logger: createLogger("silent"),
    identifiers: new VersionedHmac(legacyHmacKeyRing("x".repeat(32))),
    rateLimits: new InMemoryRateLimitStore(),
    defaultCountry: "TR",
    rateLimitPerMinute: 20,
    ingressSenderRateLimitPerMinute: 1_000,
    ingressGlobalRateLimitPerMinute: 10_000
  });
}

const incomingText = {
  externalMessageId: "wamid.in",
  from: "905551234567",
  type: "text",
  text: "yardım",
  timestamp: "1700000000"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permanent send failure handling", () => {
  it("marks the inbound message undeliverable and audits the Meta code", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sender: WhatsAppSender = {
      sendText: async () => {
        throw new WhatsAppApiError({
          httpStatus: 400,
          metaErrorCode: 131030,
          metaErrorSubcode: null,
          fbtraceId: null,
          apiMessage: null,
          hint: metaErrorHint(131030, 400),
          classification: "permanent"
        });
      }
    };
    const processor = buildProcessor(messages, audit, sender);
    const result = await processor.process(incomingText);

    expect(result).toBe("failed");
    expect(messages.undeliverable).toEqual(["message-db-1"]);
    expect(messages.statuses).not.toContain("failed");
    const failure = audit.events.find((event) => event.eventType === "whatsapp.processing");
    expect(failure?.details).toMatchObject({ metaErrorCode: 131030, terminal: true });
    expect(processor.deliveryHealth()).toEqual({
      consecutivePermanentSendFailures: 1,
      lastMetaErrorCode: 131030
    });
  });

  it("keeps retryable failures on the bounded retry path", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sender: WhatsAppSender = {
      sendText: async () => {
        throw new WhatsAppApiError({
          httpStatus: 429,
          metaErrorCode: 80007,
          metaErrorSubcode: null,
          fbtraceId: null,
          apiMessage: null,
          hint: metaErrorHint(80007, 429),
          classification: "retryable"
        });
      }
    };
    const processor = buildProcessor(messages, audit, sender);
    await processor.process(incomingText);

    expect(messages.undeliverable).toEqual([]);
    expect(messages.statuses).toContain("failed");
    const failure = audit.events.find((event) => event.eventType === "whatsapp.processing");
    expect(failure?.details).toMatchObject({ terminal: false });
  });

  it("replies with a text-only notice for unsupported message types", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sent: string[] = [];
    const sender: WhatsAppSender = {
      sendText: async (_to, text) => {
        sent.push(text);
        return { externalMessageId: "wamid.out" };
      }
    };
    const processor = buildProcessor(messages, audit, sender);
    const result = await processor.process({ ...incomingText, type: "image", text: "[image]" });

    expect(result).toBe("processed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("text");
  });

  it("sends a read receipt without letting receipt failures break processing", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const marked: string[] = [];
    const sender: WhatsAppSender = {
      sendText: async () => ({ externalMessageId: "wamid.out" }),
      markRead: async (externalMessageId) => {
        marked.push(externalMessageId);
        throw new Error("receipt endpoint down");
      }
    };
    const processor = buildProcessor(messages, audit, sender);
    const result = await processor.process(incomingText);

    expect(result).toBe("processed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(marked).toEqual(["wamid.in"]);
  });
});
