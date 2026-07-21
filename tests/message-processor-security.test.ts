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
import type { EventNotifier, IntegrationEvent } from "../src/integrations/event-notifier.js";
import { legacyHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import { InMemoryRateLimitStore } from "../src/security/rate-limiter.js";

class MemoryMessages implements MessageStore {
  inbound: SaveInboundInput[] = [];
  outbound: SaveOutboundInput[] = [];
  async saveInbound(input: SaveInboundInput): Promise<InboundMessageRecord> {
    this.inbound.push(input);
    return { id: "message-db-1", status: "received", processingAttempts: 0 };
  }
  async claimInbound(): Promise<boolean> {
    return true;
  }
  async setInboundStatus(): Promise<void> {}
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
  async sendText(): Promise<{ externalMessageId: string }> {
    return { externalMessageId: "wamid.out" };
  }
}

class SpyNotifier implements EventNotifier {
  events: IntegrationEvent[] = [];
  notify(event: IntegrationEvent): void {
    this.events.push(event);
  }
}

const permissions: PermissionLookup = { has: async () => true };
const reports: CompanyReports = {
  getSalesSummary: async (input) => ({ ...input, currencies: [], generatedAt: new Date().toISOString() }),
  getActiveProjects: async () => [],
  getOverdueTasks: async () => []
};

function build(
  users: UserLookup,
  overrides: { abuseLockoutThreshold?: number; messageMaxAgeSeconds?: number } = {}
) {
  const messages = new MemoryMessages();
  const audit = new MemoryAudit();
  const notifier = new SpyNotifier();
  const processor = new MessageProcessor({
    users,
    messages,
    audit,
    sender: new MemorySender(),
    router: new ReportCommandRouter(reports, new AuthorizationService(permissions), "Europe/Istanbul"),
    logger: createLogger("silent"),
    identifiers: new VersionedHmac(legacyHmacKeyRing("x".repeat(32))),
    rateLimits: new InMemoryRateLimitStore(),
    defaultCountry: "TR",
    ingressSenderRateLimitPerMinute: 1_000,
    ingressGlobalRateLimitPerMinute: 10_000,
    eventNotifier: notifier,
    ...overrides
  });
  return { processor, messages, audit, notifier };
}

const NO_USER: UserLookup = { findActiveByPhone: async () => null };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe("message processor security features", () => {
  it("locks out a sender after repeated unauthorized messages", async () => {
    const { processor, audit, notifier } = build(NO_USER, { abuseLockoutThreshold: 3 });
    const send = (n: number) =>
      processor.process({
        externalMessageId: `wamid.${n}`,
        from: "905551112233",
        type: "text",
        text: "let me in",
        timestamp: String(nowSeconds())
      });

    for (let i = 0; i < 3; i += 1) expect(await send(i)).toBe("unauthorized");
    // The 4th unauthorized message from the same sender trips the lockout.
    expect(await send(3)).toBe("unauthorized");

    // A sustained burst remains silent and must not fan out repeated lockout
    // events or inflate the number of locked-out senders.
    for (let i = 4; i < 104; i += 1) expect(await send(i)).toBe("unauthorized");

    expect(processor.securityHealth().lockedOutSenders).toBe(1);
    expect(audit.events.filter((event) => event.eventType === "whatsapp.lockout")).toHaveLength(1);
    expect(notifier.events.filter((event) => event.type === "sender.locked_out")).toHaveLength(1);
  });

  it("rejects a webhook message with a stale timestamp as replay", async () => {
    const { processor, audit, messages } = build(NO_USER, { messageMaxAgeSeconds: 300 });
    const result = await processor.process({
      externalMessageId: "wamid.stale",
      from: "905551112233",
      type: "text",
      text: "replayed",
      timestamp: String(nowSeconds() - 10_000)
    });
    expect(result).toBe("stale");
    expect(messages.inbound).toHaveLength(0);
    expect(audit.events[0]?.eventType).toBe("whatsapp.replay_rejected");
  });

  it("accepts a fresh message when staleness checking is enabled", async () => {
    const { processor } = build(NO_USER, { messageMaxAgeSeconds: 300 });
    const result = await processor.process({
      externalMessageId: "wamid.fresh",
      from: "905551112233",
      type: "text",
      text: "hello",
      timestamp: String(nowSeconds())
    });
    // Not whitelisted, but the freshness gate let it through to authorization.
    expect(result).toBe("unauthorized");
  });
});
