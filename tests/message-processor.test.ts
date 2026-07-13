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

function processor(users: UserLookup, messages: MemoryMessages, audit: MemoryAudit, sender: MemorySender) {
  return new MessageProcessor({
    users,
    messages,
    audit,
    sender,
    router: new ReportCommandRouter(reports, new AuthorizationService(permissions), "Europe/Istanbul"),
    logger: createLogger("silent"),
    phoneHashSecret: "x".repeat(32),
    defaultCountry: "TR"
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
    expect(messages.inbound[0]?.content).toBeNull();
    expect(messages.statuses).toEqual(["ignored"]);
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
        fullName: "Test User",
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
});
