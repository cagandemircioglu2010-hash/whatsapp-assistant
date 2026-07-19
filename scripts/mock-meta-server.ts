import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

// A local stand-in for the Meta Graph API so the whole webhook → assistant →
// send loop can be exercised without real credentials. Failure modes are
// switchable at runtime:
//
//   npm run mock:meta                       # standalone on MOCK_META_PORT (default 4545)
//   curl -X POST localhost:4545/__mock/mode -H 'content-type: application/json' \
//        -d '{"mode":"131030"}'
//
// Point the service at it with WhatsAppClient's baseUrl override (see
// scripts/e2e-local.ts) and it will observe exactly the errors production
// sees: 131030 allowed-list rejections, 190 expired tokens, throttling, 5xx.

export type MockMetaMode = "success" | "131030" | "190" | "429-once" | "500";

export type SentMessage = {
  to: string;
  text: string;
  externalMessageId: string;
};

export type MockMetaState = {
  mode: MockMetaMode;
  sent: SentMessage[];
  readReceipts: string[];
  rejectedSendAttempts: number;
};

const MODES = new Set<MockMetaMode>(["success", "131030", "190", "429-once", "500"]);

export function buildMockMetaServer(initialMode: MockMetaMode = "success"): {
  app: FastifyInstance;
  state: MockMetaState;
} {
  const state: MockMetaState = { mode: initialMode, sent: [], readReceipts: [], rejectedSendAttempts: 0 };
  let messageCounter = 0;
  let throttled = false;
  const app = Fastify({ logger: false });

  app.post<{ Params: { version: string; phoneNumberId: string }; Body: Record<string, unknown> }>(
    "/:version/:phoneNumberId/messages",
    async (request, reply) => {
      const body = request.body ?? {};

      if (body.status === "read") {
        if (typeof body.message_id === "string") state.readReceipts.push(body.message_id);
        return reply.send({ success: true });
      }

      if (state.mode === "131030") {
        state.rejectedSendAttempts += 1;
        return reply.code(400).send({
          error: {
            message: "(#131030) Recipient phone number not in allowed list",
            type: "OAuthException",
            code: 131030,
            error_data: {
              messaging_product: "whatsapp",
              details:
                "Recipient phone number not in allowed list: Add recipient phone number to recipient list and try again."
            },
            fbtrace_id: "mock-trace-131030"
          }
        });
      }
      if (state.mode === "190") {
        state.rejectedSendAttempts += 1;
        return reply.code(401).send({
          error: {
            message: "Error validating access token: Session has expired",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "mock-trace-190"
          }
        });
      }
      if (state.mode === "429-once" && !throttled) {
        throttled = true;
        state.rejectedSendAttempts += 1;
        reply.header("retry-after", "0");
        return reply.code(429).send({
          error: { message: "(#80007) Rate limit hit", type: "OAuthException", code: 80007 }
        });
      }
      if (state.mode === "500") {
        state.rejectedSendAttempts += 1;
        return reply.code(500).send({ error: { message: "Internal error", code: 131000 } });
      }

      messageCounter += 1;
      const externalMessageId = `wamid.mock.${messageCounter}`;
      const text =
        body.text !== null && typeof body.text === "object" && !Array.isArray(body.text)
          ? String((body.text as Record<string, unknown>).body ?? "")
          : "";
      state.sent.push({ to: String(body.to ?? ""), text, externalMessageId });
      return reply.send({
        messaging_product: "whatsapp",
        contacts: [{ input: String(body.to ?? ""), wa_id: String(body.to ?? "") }],
        messages: [{ id: externalMessageId }]
      });
    }
  );

  // Configuration check endpoint used by verifyConfiguration and the
  // diagnostic script.
  app.get<{ Params: { version: string; phoneNumberId: string } }>(
    "/:version/:phoneNumberId",
    async (request, reply) => {
      if (state.mode === "190") {
        return reply.code(401).send({
          error: { message: "Error validating access token: Session has expired", type: "OAuthException", code: 190 }
        });
      }
      return reply.send({
        id: request.params.phoneNumberId,
        verified_name: "Mock Business",
        quality_rating: "GREEN",
        display_phone_number: "+90 555 000 0000",
        code_verification_status: "VERIFIED"
      });
    }
  );

  app.post<{ Body: { mode?: string } }>("/__mock/mode", async (request, reply) => {
    const mode = request.body?.mode as MockMetaMode | undefined;
    if (!mode || !MODES.has(mode)) {
      return reply.code(400).send({ error: `mode must be one of: ${[...MODES].join(", ")}` });
    }
    state.mode = mode;
    throttled = false;
    return reply.send({ mode: state.mode });
  });

  app.get("/__mock/messages", async () => ({
    mode: state.mode,
    sent: state.sent,
    readReceipts: state.readReceipts,
    rejectedSendAttempts: state.rejectedSendAttempts
  }));

  app.post("/__mock/reset", async () => {
    state.sent = [];
    state.readReceipts = [];
    state.rejectedSendAttempts = 0;
    state.mode = "success";
    throttled = false;
    return { reset: true };
  });

  return { app, state };
}

// Helpers for driving the service's webhook like Meta does.

export function signWebhookBody(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

export function inboundMessagePayload(input: {
  phoneNumberId: string;
  from: string;
  text: string;
  messageId: string;
  type?: string;
}): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "mock-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "905550000000", phone_number_id: input.phoneNumberId },
              messages: [
                {
                  id: input.messageId,
                  from: input.from,
                  type: input.type ?? "text",
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                  ...(input.type && input.type !== "text"
                    ? { [input.type]: {} }
                    : { text: { body: input.text } })
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

export function statusUpdatePayload(input: {
  phoneNumberId: string;
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: number;
  errorTitle?: string;
}): Record<string, unknown> {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "mock-entry",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "905550000000", phone_number_id: input.phoneNumberId },
              statuses: [
                {
                  id: input.externalMessageId,
                  status: input.status,
                  timestamp: `${Math.floor(Date.now() / 1000)}`,
                  ...(input.errorCode !== undefined
                    ? {
                        errors: [
                          {
                            code: input.errorCode,
                            title: input.errorTitle ?? "Mock delivery failure"
                          }
                        ]
                      }
                    : {})
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

const isMainModule = process.argv[1]?.endsWith("mock-meta-server.ts") ?? false;
if (isMainModule) {
  const port = Number(process.env.MOCK_META_PORT ?? 4545);
  const { app } = buildMockMetaServer();
  const address = await app.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Mock Meta Graph API listening on ${address}\n`);
  process.stdout.write("Switch failure modes: POST /__mock/mode {\"mode\":\"131030\"}\n");
}
