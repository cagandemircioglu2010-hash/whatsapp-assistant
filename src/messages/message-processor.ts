import type { CountryCode } from "libphonenumber-js";
import type { Logger } from "pino";
import type { AssistantResponder } from "../assistant/types.js";
import type {
  AuthorizedUserIdentity,
  UserLookup,
  UserRecoveryLookup
} from "../auth/user.repository.js";
import type { AuthorizedUser } from "../auth/types.js";
import { logSafe } from "../logging/logger.js";
import { hashPhoneIdentifier, normalizePhoneNumber } from "../security/phone.js";
import { TokenBucketRateLimiter } from "../security/rate-limiter.js";
import { WhatsAppDeliveryUncertainError } from "../whatsapp/client.js";
import type {
  IncomingWhatsAppMessage,
  WhatsAppMessageStatus,
  WhatsAppSender
} from "../whatsapp/types.js";
import type { AuditStore } from "./audit.repository.js";
import type {
  MessageStore,
  MessageStatusStore,
  OutboundDeliveryStore,
  PendingInboundMessage,
  PendingMessageStore
} from "./message.repository.js";

export type ProcessingResult =
  | "queued"
  | "processed"
  | "unauthorized"
  | "rate_limited"
  | "delivery_unknown"
  | "duplicate"
  | "failed";

type MessageProcessorOptions = {
  users: UserLookup & Partial<UserRecoveryLookup>;
  messages: MessageStore &
    Partial<PendingMessageStore> &
    Partial<OutboundDeliveryStore> &
    Partial<MessageStatusStore>;
  audit: AuditStore;
  router: AssistantResponder;
  sender: WhatsAppSender;
  logger: Logger;
  phoneHashSecret: string;
  defaultCountry: CountryCode;
  rateLimitPerMinute?: number;
  workerConcurrency?: number;
};

type QueuedMessage = {
  storedId: string;
  user: AuthorizedUser;
  phoneE164: string;
  phoneHash: string;
  text: string;
};

type QueuedWork = {
  message: QueuedMessage;
  alreadyClaimed: boolean;
};

type AcceptedMessage =
  | {
      result: Exclude<
        ProcessingResult,
        "queued" | "processed" | "rate_limited" | "delivery_unknown" | "failed"
      >;
    }
  | { result: "queued"; queued: QueuedMessage };

export class MessageProcessor {
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly pendingQueue: QueuedWork[] = [];
  private readonly workerConcurrency: number;
  private readonly maxBufferedJobs: number;
  private pumpScheduled = false;

  constructor(private readonly options: MessageProcessorOptions) {
    this.rateLimiter = new TokenBucketRateLimiter(options.rateLimitPerMinute ?? 20);
    this.workerConcurrency = options.workerConcurrency ?? 4;
    if (!Number.isInteger(this.workerConcurrency) || this.workerConcurrency < 1 || this.workerConcurrency > 16) {
      throw new Error("Worker concurrency must be between 1 and 16");
    }
    this.maxBufferedJobs = Math.max(1_000, this.workerConcurrency * 250);
  }

  async process(incoming: IncomingWhatsAppMessage): Promise<ProcessingResult> {
    const accepted = await this.accept(incoming);
    if (accepted.result !== "queued") return accepted.result;
    return this.execute(accepted.queued, false);
  }

  async enqueue(incoming: IncomingWhatsAppMessage): Promise<ProcessingResult> {
    const accepted = await this.accept(incoming);
    if (accepted.result !== "queued") return accepted.result;
    if (!this.queueWork({ message: accepted.queued, alreadyClaimed: false })) {
      logSafe(
        this.options.logger,
        "warn",
        { userId: accepted.queued.user.id, messageId: accepted.queued.storedId },
        "In-memory worker queue is full; persisted message was left for recovery"
      );
    }
    return "queued";
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeTasks.size > 0 || this.pendingQueue.length > 0 || this.pumpScheduled) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const running = [...this.activeTasks];
      await Promise.race([
        ...(running.length > 0 ? running : [new Promise<void>((resolve) => setImmediate(resolve))]),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 50)))
      ]);
    }
    return true;
  }

  async drainPending(limit = 25): Promise<number> {
    const claimNext = this.options.messages.claimNextInbound;
    const findIdentity = this.options.users.findActiveIdentityById;
    if (!claimNext || !findIdentity) return 0;

    let claimed = 0;
    while (claimed < Math.min(Math.max(limit, 1), 100)) {
      let pending: PendingInboundMessage | null;
      try {
        pending = await claimNext.call(this.options.messages);
      } catch (error) {
        logSafe(this.options.logger, "error", { error }, "Pending-message recovery query failed");
        break;
      }
      if (!pending) break;
      claimed += 1;

      try {
        const identity = await findIdentity.call(this.options.users, pending.userId);
        if (!identity || pending.content === null) {
          await this.options.messages.setInboundStatus(pending.id, "ignored");
          await this.options.audit.record({
            userId: pending.userId,
            eventType: "whatsapp.recovery",
            outcome: "ignored",
            messageId: pending.id,
            details: { reason: identity ? "content_unavailable" : "user_inactive" }
          });
          continue;
        }
        const recovered = this.recoveredMessage(pending, identity);
        if (!this.queueWork({ message: recovered, alreadyClaimed: true })) {
          await this.options.messages.setInboundStatus(pending.id, "failed");
          logSafe(
            this.options.logger,
            "warn",
            { userId: pending.userId, messageId: pending.id },
            "Recovered message could not enter the bounded worker queue"
          );
          break;
        }
      } catch (error) {
        await this.markUnexpectedFailure(pending.id, pending.userId, error);
      }
    }
    return claimed;
  }

  async recordStatus(update: WhatsAppMessageStatus): Promise<void> {
    const updateStatus = this.options.messages.updateOutboundStatus;
    if (!updateStatus) return;
    const message = await updateStatus.call(
      this.options.messages,
      update.externalMessageId,
      update.status
    );
    if (!message) return;
    await this.options.audit.record({
      userId: message.userId,
      eventType: "whatsapp.delivery_status",
      outcome: update.status === "failed" ? "failure" : "success",
      messageId: message.id,
      details: { status: update.status, whatsappTimestamp: update.timestamp }
    });
  }

  private recoveredMessage(pending: PendingInboundMessage, identity: AuthorizedUserIdentity): QueuedMessage {
    return {
      storedId: pending.id,
      user: identity.user,
      phoneE164: identity.phoneE164,
      phoneHash: pending.senderPhoneHash,
      text: pending.content ?? ""
    };
  }

  private async accept(incoming: IncomingWhatsAppMessage): Promise<AcceptedMessage> {
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

    if (!user || !normalizedPhone) {
      if (stored.status === "received" || stored.status === "failed") {
        await this.options.messages.setInboundStatus(stored.id, "ignored");
        await this.options.audit.record({
          eventType: "whatsapp.authorization",
          outcome: "denied",
          messageId: stored.id,
          details: { senderReference: phoneHash.slice(0, 12), reason: "not_whitelisted" }
        });
      }
      logSafe(
        this.options.logger,
        "warn",
        { senderReference: phoneHash.slice(0, 12) },
        "Ignored WhatsApp message from a non-whitelisted sender"
      );
      return { result: "unauthorized" };
    }

    if (stored.status !== "received" && stored.status !== "failed") return { result: "duplicate" };
    return {
      result: "queued",
      queued: {
        storedId: stored.id,
        user,
        phoneE164: normalizedPhone,
        phoneHash,
        text: incoming.text
      }
    };
  }

  private queueWork(work: QueuedWork): boolean {
    if (this.pendingQueue.length + this.activeTasks.size >= this.maxBufferedJobs) return false;
    this.pendingQueue.push(work);
    this.schedulePump();
    return true;
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeTasks.size < this.workerConcurrency) {
      const work = this.pendingQueue.shift();
      if (!work) return;
      const task = this.runQueuedSafely(work.message, work.alreadyClaimed);
      this.activeTasks.add(task);
      const settled = () => {
        this.activeTasks.delete(task);
        this.pump();
      };
      void task.then(settled, settled);
    }
  }

  private async runQueuedSafely(queued: QueuedMessage, alreadyClaimed: boolean): Promise<void> {
    try {
      await this.execute(queued, alreadyClaimed);
    } catch (error) {
      await this.markUnexpectedFailure(queued.storedId, queued.user.id, error);
    }
  }

  private async execute(queued: QueuedMessage, alreadyClaimed: boolean): Promise<ProcessingResult> {
    if (!alreadyClaimed && !(await this.options.messages.claimInbound(queued.storedId))) return "duplicate";

    if (!this.rateLimiter.consume(queued.user.id)) {
      await this.options.messages.setInboundStatus(queued.storedId, "ignored");
      await this.options.audit.record({
        userId: queued.user.id,
        eventType: "whatsapp.rate_limit",
        outcome: "denied",
        messageId: queued.storedId,
        details: { window: "one_minute" }
      });
      logSafe(
        this.options.logger,
        "warn",
        { userId: queued.user.id, messageId: queued.storedId },
        "WhatsApp sender exceeded the per-user rate limit"
      );
      return "rate_limited";
    }

    try {
      const command = await this.options.router.handle(queued.user, queued.text, {
        messageId: queued.storedId
      });
      await this.options.audit.record({
        userId: queued.user.id,
        eventType: "company.report_request",
        resource: command.resource,
        outcome: command.outcome === "success" ? "success" : command.outcome === "denied" ? "denied" : "ignored",
        messageId: queued.storedId,
        details: { resources: command.resources }
      });

      const delivery = await this.deliverReply(queued, command);
      await this.options.messages.setInboundStatus(queued.storedId, "processed");
      if (delivery === "unknown") {
        await this.options.audit.record({
          userId: queued.user.id,
          eventType: "whatsapp.delivery",
          outcome: "failure",
          messageId: queued.storedId,
          details: { state: "delivery_unknown", automaticRetry: false }
        });
        logSafe(
          this.options.logger,
          "error",
          { userId: queued.user.id, messageId: queued.storedId },
          "WhatsApp delivery outcome is unknown; automatic retry was suppressed"
        );
        return "delivery_unknown";
      }
      logSafe(
        this.options.logger,
        "info",
        { userId: queued.user.id, messageId: queued.storedId, resource: command.resource },
        "Processed WhatsApp message"
      );
      return "processed";
    } catch (error) {
      await this.markUnexpectedFailure(queued.storedId, queued.user.id, error);
      return "failed";
    }
  }

  private async deliverReply(
    queued: QueuedMessage,
    command: Awaited<ReturnType<AssistantResponder["handle"]>>
  ): Promise<"sent" | "unknown"> {
    const reserve = this.options.messages.reserveOutbound;
    const markSent = this.options.messages.markOutboundSent;
    const markFailed = this.options.messages.markOutboundFailed;
    const markUnknown = this.options.messages.markOutboundDeliveryUnknown;

    if (!reserve || !markSent || !markFailed || !markUnknown) {
      const sent = await this.options.sender.sendText(queued.phoneE164, command.text);
      await this.options.messages.saveOutbound({
        externalMessageId: sent.externalMessageId,
        userId: queued.user.id,
        content: command.text,
        senderPhoneHash: queued.phoneHash,
        status: "sent",
        metadata: { resources: command.resources, outcome: command.outcome }
      });
      return "sent";
    }

    const reservation = await reserve.call(this.options.messages, {
      replyToMessageId: queued.storedId,
      userId: queued.user.id,
      content: command.text,
      senderPhoneHash: queued.phoneHash,
      metadata: { resources: command.resources, outcome: command.outcome }
    });
    if (!reservation.shouldSend) {
      if (["sent", "delivered", "read"].includes(reservation.status)) return "sent";
      await markUnknown.call(this.options.messages, reservation.id);
      return "unknown";
    }

    let sent: { externalMessageId: string };
    try {
      sent = await this.options.sender.sendText(queued.phoneE164, command.text);
    } catch (error) {
      if (error instanceof WhatsAppDeliveryUncertainError) {
        await markUnknown.call(this.options.messages, reservation.id);
        return "unknown";
      }
      await markFailed.call(this.options.messages, reservation.id);
      throw error;
    }

    try {
      await markSent.call(this.options.messages, reservation.id, sent.externalMessageId);
      return "sent";
    } catch {
      await markUnknown.call(this.options.messages, reservation.id);
      return "unknown";
    }
  }

  private async markUnexpectedFailure(messageId: string, userId: string, error: unknown): Promise<void> {
    await this.options.messages.setInboundStatus(messageId, "failed").catch(() => undefined);
    await this.options.audit
      .record({
        userId,
        eventType: "whatsapp.processing",
        outcome: "failure",
        messageId,
        details: { errorType: error instanceof Error ? error.name : "UnknownError" }
      })
      .catch(() => undefined);
    logSafe(
      this.options.logger,
      "error",
      { error, userId, messageId },
      "WhatsApp message processing failed"
    );
  }
}
