import { describe, expect, it } from "vitest";
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
import type { WhatsAppSender } from "../src/whatsapp/types.js";
import { WhatsAppDeliveryUncertainError } from "../src/whatsapp/client.js";
import { legacyHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import { InMemoryRateLimitStore } from "../src/security/rate-limiter.js";

class MemoryMessages implements MessageStore {
  inbound: SaveInboundInput[] = [];
  outbound: SaveOutboundInput[] = [];
  statuses: string[] = [];
  async saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord> {
    this.inbound.push(input);
    return { id: "message-db-1", status: "received", processingAttempts: 0 };
  }
  async claimInbound(): Promise<boolean> {
    return true;
  }
  async setInboundStatus(_messageId: string, status: "processed" | "ignored" | "failed"): Promise<void> {
    this.statuses.push(status);
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

class MemorySender implements WhatsAppSender {
  calls: Array<{ to: string; text: string }> = [];
  async sendText(to: string, text: string): Promise<{ externalMessageId: string }> {
    this.calls.push({ to, text });
    return { externalMessageId: "wamid.out" };
  }
}

const permissions: PermissionLookup = { has: async () => true };
const reports: CompanyReports = {
  getSalesSummary: async (input) => ({ ...input, currencies: [], generatedAt: new Date().toISOString() }),
  getActiveProjects: async () => [],
  getOverdueTasks: async () => []
};

function processor(
  users: UserLookup,
  messages: MemoryMessages,
  audit: MemoryAudit,
  sender: WhatsAppSender,
  rateLimitPerMinute = 20
) {
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
    rateLimitPerMinute,
    ingressSenderRateLimitPerMinute: 1_000,
    ingressGlobalRateLimitPerMinute: 10_000
  });
}

describe("message processor", () => {
  it("stores no content and sends no reply for non-whitelisted numbers", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sender = new MemorySender();
    const result = await processor({ findActiveByPhone: async () => null }, messages, audit, sender).process({
      externalMessageId: "wamid.unauthorized",
      from: "905551234567",
      type: "text",
      text: "Give me all salaries",
      timestamp: "1700000000"
    });

    expect(result).toBe("unauthorized");
    expect(messages.inbound).toHaveLength(0);
    expect(messages.statuses).toEqual([]);
    expect(sender.calls).toHaveLength(0);
    expect(audit.events[0]?.outcome).toBe("denied");
  });

  it("stores authorized conversation history and sends the report reply", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sender = new MemorySender();
    const users: UserLookup = {
      findActiveByPhone: async () => ({
        id: "user-1",
        department: "Sales",
        role: "employee"
      })
    };
    const result = await processor(users, messages, audit, sender).process({
      externalMessageId: "wamid.authorized",
      from: "905551234567",
      type: "text",
      text: "Satış özeti",
      timestamp: "1700000000"
    });

    expect(result).toBe("processed");
    expect(messages.inbound[0]?.content).toBe("Satış özeti");
    expect(messages.outbound[0]?.content).toContain("satış");
    expect(messages.statuses).toEqual(["processed"]);
    expect(sender.calls).toHaveLength(1);
  });

  it("rate-limits repeated authorized work before calling reports or WhatsApp", async () => {
    const messages = new MemoryMessages();
    const audit = new MemoryAudit();
    const sender = new MemorySender();
    const users: UserLookup = {
      findActiveByPhone: async () => ({
        id: "rate-user",
        department: "Sales",
        role: "employee"
      })
    };
    const instance = processor(users, messages, audit, sender, 1);
    const incoming = {
      externalMessageId: "wamid.rate.1",
      from: "905551234567",
      type: "text",
      text: "Satış özeti",
      timestamp: "1700000000"
    };

    expect(await instance.process(incoming)).toBe("processed");
    expect(await instance.process({ ...incoming, externalMessageId: "wamid.rate.2" })).toBe("rate_limited");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The report pipeline ran exactly once; the extra send is the deliberate
    // "slow down" notice, itself capped at one per minute.
    const noticeCalls = sender.calls.filter((call) => call.text.includes("too quickly"));
    expect(noticeCalls).toHaveLength(1);
    expect(sender.calls).toHaveLength(2);
    expect(audit.events.some((event) => event.eventType === "whatsapp.rate_limit")).toBe(true);
  });

  it("suppresses automatic retries when the delivery result is uncertain", async () => {
    class OutboxMessages extends MemoryMessages {
      unknown = false;
      async reserveOutbound() {
        return { id: "outbox-1", status: "sending", shouldSend: true };
      }
      async markOutboundSent(): Promise<void> {}
      async markOutboundFailed(): Promise<void> {}
      async markOutboundDeliveryUnknown(): Promise<void> {
        this.unknown = true;
      }
    }
    const messages = new OutboxMessages();
    const audit = new MemoryAudit();
    const users: UserLookup = {
      findActiveByPhone: async () => ({
        id: "user-1",
        department: "Sales",
        role: "employee"
      })
    };
    const uncertainSender: WhatsAppSender = {
      sendText: async () => {
        throw new WhatsAppDeliveryUncertainError();
      }
    };

    const result = await processor(users, messages, audit, uncertainSender).process({
      externalMessageId: "wamid.uncertain",
      from: "905551234567",
      type: "text",
      text: "Satış özeti",
      timestamp: "1700000000"
    });
    expect(result).toBe("delivery_unknown");
    expect(messages.unknown).toBe(true);
    expect(messages.statuses.at(-1)).toBe("processed");
    expect(audit.events.some((event) => event.eventType === "whatsapp.delivery")).toBe(true);
  });
});
