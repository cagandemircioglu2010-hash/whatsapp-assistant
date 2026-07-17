import { createHmac } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageProcessor } from "../src/messages/message-processor.js";
import { registerWhatsAppRoutes, summarizeWebhookPayload } from "../src/whatsapp/routes.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

async function appWithProcessor(
  enqueue: (message: unknown) => Promise<"queued">,
  recordStatus: (status: unknown) => Promise<void> = async () => undefined
) {
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  apps.push(app);
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = rawBody;
    done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
  });
  await registerWhatsAppRoutes(app, {
    config: {
      enabled: true,
      verifyToken: "verify-token-with-32-characters",
      accessToken: "x".repeat(30),
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      appSecret: "meta-app-secret-with-32-characters",
      requireSignature: true,
      debugLogging: false
    },
    processor: { enqueue, recordStatus } as unknown as MessageProcessor,
    logger: { info: vi.fn() } as unknown as Logger
  });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("WhatsApp webhook routes", () => {
  it("summarizes webhook payloads without exposing identifiers or message content", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "123456789" },
            messages: [{
              id: "wamid.secret",
              from: "905551234567",
              type: "text",
              text: { body: "Confidential report request" }
            }],
            statuses: [{ id: "wamid.out", status: "delivered" }]
          }
        }]
      }]
    };

    const summary = summarizeWebhookPayload(payload, "123456789");
    expect(summary).toEqual({
      object: "whatsapp_business_account",
      entryCount: 1,
      changeCount: 1,
      messageCount: 1,
      statusCount: 1,
      messageTypes: ["text"],
      statusValues: ["delivered"],
      matchingPhoneNumberIds: 1,
      mismatchedPhoneNumberIds: 0
    });
    expect(JSON.stringify(summary)).not.toContain("905551234567");
    expect(JSON.stringify(summary)).not.toContain("Confidential report request");
    expect(JSON.stringify(summary)).not.toContain("wamid.secret");
  });

  it("uses a constant-time token check and validates the challenge shape", async () => {
    const app = await appWithProcessor(async () => "queued");
    const accepted = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-with-32-characters&hub.challenge=12345"
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toBe("12345");

    const reflectedText = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token-with-32-characters&hub.challenge=%3Cscript%3E"
    });
    expect(reflectedText.statusCode).toBe(403);
  });

  it("rejects an invalid signature before parsing or queueing messages", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const app = await appWithProcessor(enqueue);
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      payload: { entry: [] }
    });
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("durably queues a valid signed message before acknowledging Meta", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const app = await appWithProcessor(enqueue);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.route",
                    from: "905551234567",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Satış özeti" }
                  }
                ]
              }
            }
          ]
        }
      ]
    });
    const signature = createHmac("sha256", "meta-app-secret-with-32-characters")
      .update(payload)
      .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, queued: 1, statuses: 0 });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("records signed outbound status updates without queueing an inbound message", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const recordStatus = vi.fn(async () => undefined);
    const app = await appWithProcessor(enqueue, recordStatus);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                statuses: [{ id: "wamid.out", status: "read", timestamp: "1700000010" }]
              }
            }
          ]
        }
      ]
    });
    const signature = createHmac("sha256", "meta-app-secret-with-32-characters")
      .update(payload)
      .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`
      },
      payload
    });

    expect(response.json()).toEqual({ received: true, queued: 0, statuses: 1 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(recordStatus).toHaveBeenCalledWith({
      externalMessageId: "wamid.out",
      status: "read",
      timestamp: "1700000010"
    });
  });

  it("ignores signed events targeted at another WhatsApp phone number", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const app = await appWithProcessor(enqueue);
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "987654321" },
            messages: [{
              id: "wamid.wrong-tenant",
              from: "905551234567",
              timestamp: "1700000000",
              type: "text",
              text: { body: "Satış özeti" }
            }]
          }
        }]
      }]
    });
    const signature = createHmac("sha256", "meta-app-secret-with-32-characters")
      .update(payload)
      .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`
      },
      payload
    });

    expect(response.json()).toEqual({ received: true, queued: 0, statuses: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
