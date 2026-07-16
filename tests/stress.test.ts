import { describe, expect, it } from "vitest";
import type { UserLookup } from "../src/auth/user.repository.js";
import { createLogger } from "../src/logging/logger.js";
import type { AuditStore } from "../src/messages/audit.repository.js";
import { MessageProcessor } from "../src/messages/message-processor.js";
import type {
  InboundMessageRecord,
  MessageStore,
  SaveInboundInput,
  SaveOutboundInput
} from "../src/messages/message.repository.js";
import { TokenBucketRateLimiter } from "../src/security/rate-limiter.js";
import { InMemoryRateLimitStore } from "../src/security/rate-limiter.js";
import { legacyHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import type { WhatsAppSender } from "../src/whatsapp/types.js";
import { parseIncomingMessages } from "../src/whatsapp/webhook-parser.js";

describe("adversarial and stress behavior", () => {
  it("never throws for malformed and deeply unusual webhook values", () => {
    const values: unknown[] = [
      null,
      undefined,
      true,
      42,
      "payload",
      [],
      {},
      { entry: [null, 1, "x", { changes: [null, { value: { messages: [null, [], {}] } }] }] },
      { entry: Array.from({ length: 1000 }, () => ({ changes: "invalid" })) }
    ];
    for (let index = 0; index < 2000; index += 1) {
      values.push({ entry: [{ changes: [{ value: { messages: [{ id: index }] } }] }] });
    }
    for (const value of values) expect(() => parseIncomingMessages(value)).not.toThrow();
  });

  it("bounds batch expansion, strips control characters, and deduplicates message ids", () => {
    const messages = Array.from({ length: 150 }, (_, index) => ({
      id: index < 2 ? "wamid.duplicate" : `wamid.${index}`,
      from: "905551234567",
      timestamp: "1700000000",
      type: "text",
      text: { body: `A\u0000\u202E${"x".repeat(5000)}` }
    }));
    const parsed = parseIncomingMessages({ entry: [{ changes: [{ value: { messages } }] }] });

    expect(parsed).toHaveLength(99);
    expect(parsed[0]?.text).not.toMatch(/[\u0000\u202E]/);
    expect(parsed[0]?.text.length).toBe(4096);
  });

  it("caps the total result across nested entry and change arrays", () => {
    let id = 0;
    const entry = Array.from({ length: 10 }, () => ({
      changes: Array.from({ length: 10 }, () => ({
        value: {
          messages: Array.from({ length: 20 }, () => ({
            id: `wamid.nested.${id++}`,
            from: "905551234567",
            timestamp: "1700000000",
            type: "text",
            text: { body: "durum" }
          }))
        }
      }))
    }));

    expect(parseIncomingMessages({ entry })).toHaveLength(100);
  });

  it("processes 500 independent messages concurrently without losing a reply", async () => {
    let outbound = 0;
    const messages: MessageStore = {
      saveInbound: async (input: SaveInboundInput): Promise<InboundMessageRecord> => ({
        id: input.externalMessageId,
        status: "received",
        processingAttempts: 0
      }),
      claimInbound: async () => true,
      setInboundStatus: async () => undefined,
      saveOutbound: async (_input: SaveOutboundInput) => {
        outbound += 1;
        return `out-${outbound}`;
      }
    };
    const users: UserLookup = {
      findActiveByPhone: async () => ({
        id: "stress-user",
        department: "Engineering",
        role: "employee"
      })
    };
    const audit: AuditStore = { record: async () => undefined };
    const sender: WhatsAppSender = {
      sendText: async () => ({ externalMessageId: `wamid.out.${outbound}` })
    };
    const processor = new MessageProcessor({
      users,
      messages,
      audit,
      sender,
      router: {
        handle: async () => ({
          text: "ok",
          resource: null,
          resources: [],
          outcome: "unsupported"
        })
      },
      logger: createLogger("silent"),
      identifiers: new VersionedHmac(legacyHmacKeyRing("x".repeat(32))),
      rateLimits: new InMemoryRateLimitStore(),
      defaultCountry: "TR",
      rateLimitPerMinute: 1000,
      ingressSenderRateLimitPerMinute: 1000,
      ingressGlobalRateLimitPerMinute: 10000
    });

    const results = await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        processor.process({
          externalMessageId: `wamid.stress.${index}`,
          from: "905551234567",
          timestamp: "1700000000",
          type: "text",
          text: "durum"
        })
      )
    );
    expect(results.every((result) => result === "processed")).toBe(true);
    expect(outbound).toBe(500);
  });

  it("bounds background webhook work at the configured concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    let outbound = 0;
    const messages: MessageStore = {
      saveInbound: async (input) => ({
        id: input.externalMessageId,
        status: "received",
        processingAttempts: 0
      }),
      claimInbound: async () => true,
      setInboundStatus: async () => undefined,
      saveOutbound: async () => {
        outbound += 1;
        return `out-${outbound}`;
      }
    };
    const processor = new MessageProcessor({
      users: {
        findActiveByPhone: async () => ({
          id: "bounded-user",
          department: "Engineering",
          role: "employee"
        })
      },
      messages,
      audit: { record: async () => undefined },
      sender: { sendText: async () => ({ externalMessageId: `wamid.out.${outbound}` }) },
      router: {
        handle: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
          return { text: "ok", resource: null, resources: [], outcome: "unsupported" };
        }
      },
      logger: createLogger("silent"),
      identifiers: new VersionedHmac(legacyHmacKeyRing("x".repeat(32))),
      rateLimits: new InMemoryRateLimitStore(),
      defaultCountry: "TR",
      rateLimitPerMinute: 1000,
      ingressSenderRateLimitPerMinute: 1000,
      ingressGlobalRateLimitPerMinute: 10000,
      workerConcurrency: 3
    });

    const accepted = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        processor.enqueue({
          externalMessageId: `wamid.queued.${index}`,
          from: "905551234567",
          timestamp: "1700000000",
          type: "text",
          text: "durum"
        })
      )
    );
    expect(accepted.every((result) => result === "queued")).toBe(true);
    expect(await processor.waitForIdle(5_000)).toBe(true);
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(outbound).toBe(60);
  });

  it("keeps the token-bucket map bounded under a high-cardinality flood", () => {
    const limiter = new TokenBucketRateLimiter(5, 60_000, 100);
    for (let index = 0; index < 10_000; index += 1) limiter.consume(`sender-${index}`, index);
    expect(limiter.consume("final-sender", 10_001)).toBe(true);
  });
});
