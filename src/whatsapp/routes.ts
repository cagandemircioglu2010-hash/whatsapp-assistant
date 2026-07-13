import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config/env.js";
import type { MessageProcessor } from "../messages/message-processor.js";
import { parseIncomingMessages } from "./webhook-parser.js";
import { verifyMetaSignature } from "./signature.js";

type RouteDependencies = {
  config: AppConfig["whatsapp"];
  processor: MessageProcessor;
};

export async function registerWhatsAppRoutes(app: FastifyInstance, dependencies: RouteDependencies): Promise<void> {
  app.get<{ Querystring: { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string } }>(
    "/webhooks/whatsapp",
    async (request, reply) => {
      if (!dependencies.config.enabled) return reply.code(503).send({ error: "WhatsApp integration is disabled" });
      const query = request.query;
      if (
        query["hub.mode"] === "subscribe" &&
        query["hub.verify_token"] === dependencies.config.verifyToken &&
        query["hub.challenge"]
      ) {
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

    const incomingMessages = parseIncomingMessages(request.body);
    let failed = false;
    for (const incoming of incomingMessages) {
      if ((await dependencies.processor.process(incoming)) === "failed") failed = true;
    }

    if (failed) return reply.code(500).send({ error: "One or more messages could not be processed" });
    return reply.code(200).send({ received: true, messages: incomingMessages.length });
  });
}
