import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging/logger.js";
import {
  NoopEventNotifier,
  SignedHttpEventNotifier,
  verifyIntegrationSignature,
  INTEGRATION_SIGNATURE_HEADER,
  INTEGRATION_TIMESTAMP_HEADER
} from "../src/integrations/event-notifier.js";

// Obvious placeholder value for tests only (not a real secret).
const SECRET = "example-integration-secret-value";

describe("signed event notifier", () => {
  it("posts an HMAC-signed body that verifies with the shared secret", async () => {
    const calls: Array<{ url: string; body: string; signature: string; timestamp: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({
        url,
        body: String(init.body),
        signature: headers[INTEGRATION_SIGNATURE_HEADER]!,
        timestamp: headers[INTEGRATION_TIMESTAMP_HEADER]!
      });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const notifier = new SignedHttpEventNotifier({
      url: "https://ops.example/hook",
      secret: SECRET,
      logger: createLogger("silent"),
      fetchImpl,
      now: () => 1_700_000_000_000
    });
    notifier.notify({ type: "sender.locked_out", details: { senderHash: "abc123" } });
    await notifier.drain();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ops.example/hook");
    expect(calls[0]?.timestamp).toBe("1700000000");
    expect(verifyIntegrationSignature(SECRET, calls[0]!.body, calls[0]!.signature)).toBe(true);
    expect(verifyIntegrationSignature("wrong-secret-000000000000", calls[0]!.body, calls[0]!.signature)).toBe(false);
    const payload = JSON.parse(calls[0]!.body) as { type: string; details: Record<string, unknown> };
    expect(payload.type).toBe("sender.locked_out");
    expect(payload.details).toEqual({ senderHash: "abc123" });
  });

  it("never throws out of notify when the endpoint fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const notifier = new SignedHttpEventNotifier({
      url: "https://ops.example/hook",
      secret: SECRET,
      logger: createLogger("silent"),
      fetchImpl
    });
    expect(() => notifier.notify({ type: "send.permanent_failure", details: { metaErrorCode: 190 } })).not.toThrow();
    await expect(notifier.drain()).resolves.toBeUndefined();
  });

  it("noop notifier does nothing", () => {
    expect(() => new NoopEventNotifier().notify({ type: "sender.locked_out" })).not.toThrow();
  });
});
