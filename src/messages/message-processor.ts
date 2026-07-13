import type { CountryCode } from "libphonenumber-js";
import type { Logger } from "pino";
import type { UserLookup } from "../auth/user.repository.js";
import type { AssistantResponder } from "../assistant/types.js";
import { logSafe } from "../logging/logger.js";
import { hashPhoneIdentifier, normalizePhoneNumber, phoneLastFour } from "../security/phone.js";
import type { IncomingWhatsAppMessage, WhatsAppSender } from "../whatsapp/types.js";
import type { AuditStore } from "./audit.repository.js";
import type { MessageStore } from "./message.repository.js";

export type ProcessingResult = "processed" | "unauthorized" | "duplicate" | "failed";

type MessageProcessorOptions = {
  users: UserLookup;
  messages: MessageStore;
  audit: AuditStore;
  router: AssistantResponder;
  sender: WhatsAppSender;
  logger: Logger;
  phoneHashSecret: string;
  defaultCountry: CountryCode;
};

export class MessageProcessor {
  constructor(private readonly options: MessageProcessorOptions) {}

  async process(incoming: IncomingWhatsAppMessage): Promise<ProcessingResult> {
    const normalizedPhone = normalizePhoneNumber(incoming.from, this.options.defaultCountry);
    const phoneForHash = normalizedPhone ?? incoming.from;
    const phoneHash = hashPhoneIdentifier(phoneForHash, this.options.phoneHashSecret);
    const user = normalizedPhone ? await this.options.users.findActiveByPhone(normalizedPhone) : null;

    const stored = await this.options.messages.saveInbound({
      externalMessageId: incoming.externalMessageId,
      userId: user?.id ?? null,
      content: user ? incoming.text : null,
      senderPhoneHash: phoneHash,
      messageType: incoming.type,
      metadata: {
        whatsappTimestamp: incoming.timestamp,
        authorization: user ? "allowed" : "denied"
      }
    });

    if (!user) {
      if (stored.status === "received" || stored.status === "processing") {
        await this.options.messages.setInboundStatus(stored.id, "ignored");
        await this.options.audit.record({
          eventType: "whatsapp.authorization",
          outcome: "denied",
          messageId: stored.id,
          details: { phoneLastFour: phoneLastFour(phoneForHash), reason: "not_whitelisted" }
        });
      }
      logSafe(
        this.options.logger,
        "warn",
        { messageId: incoming.externalMessageId, phoneLastFour: phoneLastFour(phoneForHash) },
        "Ignored WhatsApp message from a non-whitelisted sender"
      );
      return "unauthorized";
    }

    if (!(await this.options.messages.claimInbound(stored.id))) return "duplicate";

    try {
      const command = await this.options.router.handle(user, incoming.text, { messageId: stored.id });
      await this.options.audit.record({
        userId: user.id,
        eventType: "company.report_request",
        resource: command.resource,
        outcome: command.outcome === "success" ? "success" : command.outcome === "denied" ? "denied" : "ignored",
        messageId: stored.id,
        details: { resources: command.resources }
      });

      const sent = await this.options.sender.sendText(normalizedPhone!, command.text);
      await this.options.messages.saveOutbound({
        externalMessageId: sent.externalMessageId,
        userId: user.id,
        content: command.text,
        senderPhoneHash: phoneHash,
        status: "sent",
        metadata: { resources: command.resources, outcome: command.outcome }
      });
      await this.options.messages.setInboundStatus(stored.id, "processed");
      logSafe(
        this.options.logger,
        "info",
        { userId: user.id, messageId: incoming.externalMessageId, resource: command.resource },
        "Processed WhatsApp message"
      );
      return "processed";
    } catch (error) {
      await this.options.messages.setInboundStatus(stored.id, "failed");
      await this.options.audit.record({
        userId: user.id,
        eventType: "whatsapp.processing",
        outcome: "failure",
        messageId: stored.id,
        details: { errorType: error instanceof Error ? error.name : "UnknownError" }
      });
      logSafe(
        this.options.logger,
        "error",
        { error, userId: user.id, messageId: incoming.externalMessageId },
        "WhatsApp message processing failed"
      );
      return "failed";
    }
  }
}
