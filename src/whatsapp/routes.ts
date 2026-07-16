import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/env.js";
import type { MessageProcessor } from "../messages/message-processor.js";
import { parseIncomingMessages, parseMessageStatusUpdates } from "./webhook-parser.js";
import { timingSafeStringEqual, verifyMetaSignature } from "./signature.js";

type RouteDependencies = {
  config: AppConfig["whatsapp"];
  processor: MessageProcessor;
  isDecommissioned?: () => Promise<boolean>;
};

export async function registerWhatsAppRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get<{ Querystring: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string } }>(
    "/webhooks/whatsapp",
    async (request, reply) => {
      if (!dependencies.config.enabled) return reply.code(503).send({ error: "WhatsApp integration is disabled" });
      const query = request.query;
      if (
        query["hub.mode"] === "subscribe" &&
        timingSafeStringEqual(query["hub.verify_token"], dependencies.config.verifyToken) &&
        query["hub.challenge"] &&
        /^\d{1,256}$/.test(query["hub.challenge"])
      ) {
        if (await dependencies.isDecommissioned?.()) {
          return reply.code(503).send({ error: "Service is decommissioned" });
        }
        return reply.type("text/plain").send(query["hub.challenge"]);
      }
      return reply.code(403).send({ error: "Webhook verification failed" });
    }
  );

  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (!dependencies.config.enabled) return reply.code(503).send({ error: "WhatsApp integration is disabled" });

    if (dependencies.config.requireSignature) {
      const signature = request.headers["x-hub-signature-256"];
      const signatureValue = Array.isArray(signature) ? signature[0] : signature;
      if (
        !request.rawBody ||
        !dependencies.config.appSecret ||
        !verifyMetaSignature(request.rawBody, signatureValue, dependencies.config.appSecret)
      ) {
        return reply.code(401).send({ error: "Invalid webhook signature" });
      }
    }
    if (await dependencies.isDecommissioned?.()) {
      return reply.code(503).send({ error: "Service is decommissioned" });
    }

    const expectedPhoneNumberId = dependencies.config.phoneNumberId;
    const incomingMessages = parseIncomingMessages(request.body, expectedPhoneNumberId);
    const statusUpdates = parseMessageStatusUpdates(request.body, expectedPhoneNumberId);
    let queued = 0;
    for (let index = 0; index < incomingMessages.length; index += 4) {
      const batch = incomingMessages.slice(index, index + 4);
      const results = await Promise.all(batch.map((incoming) => dependencies.processor.enqueue(incoming)));
      queued += results.filter((result) => result === "queued").length;
    }
    for (let index = 0; index < statusUpdates.length; index += 10) {
      await Promise.all(
        statusUpdates.slice(index, index + 10).map((status) => dependencies.processor.recordStatus(status))
      );
    }

    return reply
      .code(200)
      .send({ received: true, queued, statuses: statusUpdates.length });
  });
}
