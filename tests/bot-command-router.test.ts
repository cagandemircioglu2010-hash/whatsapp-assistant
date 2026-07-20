import { describe, expect, it } from "vitest";
import { BotCommandRouter } from "../src/assistant/bot-command-router.js";
import type { AuthorizedUser } from "../src/auth/types.js";
import { createLogger } from "../src/logging/logger.js";
import type { AuditInput, AuditStore } from "../src/messages/audit.repository.js";
import type { AssistantResponder, AssistantResponse } from "../src/assistant/types.js";

class MemoryAudit implements AuditStore {
  events: AuditInput[] = [];
  async record(input: AuditInput): Promise<void> {
    this.events.push(input);
  }
}

class SpyResponder implements AssistantResponder {
  calls = 0;
  async handle(): Promise<AssistantResponse> {
    this.calls += 1;
    return { text: "downstream", resource: null, resources: [], outcome: "success" };
  }
}

function build(defaultLocale: "tr" | "en" = "tr") {
  const audit = new MemoryAudit();
  const next = new SpyResponder();
  const router = new BotCommandRouter(next, { audit, logger: createLogger("silent"), defaultLocale });
  return { audit, next, router };
}

const user: AuthorizedUser = { id: "user-1", department: "Sales", role: "employee" };
const context = { messageId: "message-1" };

describe("bot command router", () => {
  it("answers the privacy notice in the user's locale without auditing", async () => {
    const { audit, next, router } = build("tr");
    const response = await router.handle(user, "gizlilik", context);
    expect(response.text).toContain("Gizlilik");
    expect(next.calls).toBe(0);
    expect(audit.events).toHaveLength(0);
  });

  it("records an audited erasure request and confirms", async () => {
    const { audit, next, router } = build("en");
    const response = await router.handle({ ...user, locale: "en" }, "please delete my data", context);
    expect(response.text.toLowerCase()).toContain("erasure request");
    expect(next.calls).toBe(0);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.eventType).toBe("privacy.erasure_request");
    expect(audit.events[0]?.messageId).toBe("message-1");
  });

  it("records an audited access request and confirms", async () => {
    const { audit, router } = build("tr");
    const response = await router.handle(user, "erişim istiyorum", context);
    expect(response.text).toContain("Erişim");
    expect(audit.events[0]?.eventType).toBe("identity.access_request");
  });

  it("prefers erasure over the generic privacy notice", async () => {
    const { audit, router } = build("tr");
    await router.handle(user, "verilerimi sil lütfen", context);
    expect(audit.events[0]?.eventType).toBe("privacy.erasure_request");
  });

  it("delegates anything unrecognized to the downstream responder", async () => {
    const { next, audit, router } = build();
    const response = await router.handle(user, "satış özeti", context);
    expect(response.text).toBe("downstream");
    expect(next.calls).toBe(1);
    expect(audit.events).toHaveLength(0);
  });
});
