import type { CountryCode } from "libphonenumber-js";
import type { Logger } from "pino";
import { systemMessage, type AssistantLocale } from "../assistant/system-messages.js";
import type { AssistantResponder, ConversationTurn } from "../assistant/types.js";
import type {
  AuthorizedUserIdentity,
  UserLookup,
  UserRecoveryLookup
} from "../auth/user.repository.js";
import type { AuthorizedUser } from "../auth/types.js";
import { logSafe } from "../logging/logger.js";
import { normalizePhoneNumber } from "../security/phone.js";
import type { VersionedHash, VersionedHmac } from "../security/keyed-hash.js";
import type { RateLimitStore } from "../security/rate-limiter.js";
import {
  isPermanentSendError,
  WhatsAppApiError,
  WhatsAppDeliveryUncertainError
} from "../whatsapp/client.js";
import { metaErrorHint } from "../whatsapp/meta-errors.js";
import { NoopEventNotifier, type EventNotifier } from "../integrations/event-notifier.js";
import type {
  IncomingWhatsAppMessage,
  WhatsAppMessageStatus,
  WhatsAppSender
} from "../whatsapp/types.js";
import type { AuditStore } from "./audit.repository.js";
import type {
  ConversationHistoryStore,
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
  | "stale"
  | "failed";

type MessageProcessorOptions = {
  users: UserLookup & Partial<UserRecoveryLookup>;
  messages: MessageStore &
    Partial<PendingMessageStore> &
    Partial<OutboundDeliveryStore> &
    Partial<MessageStatusStore> &
    Partial<ConversationHistoryStore>;
  audit: AuditStore;
  router: AssistantResponder;
  sender: WhatsAppSender;
  logger: Logger;
  identifiers: VersionedHmac;
  rateLimits: RateLimitStore;
  defaultCountry: CountryCode;
  rateLimitPerMinute?: number;
  ingressSenderRateLimitPerMinute?: number;
  ingressGlobalRateLimitPerMinute?: number;
  workerConcurrency?: number;
  locale?: AssistantLocale;
  // Repeated unauthorized inbound from one sender within a minute past this
  // count trips a lockout for the remainder of the window. Defaults to 10.
  abuseLockoutThreshold?: number;
  // Inbound webhook messages whose Meta timestamp is older or further in the
  // future than this many seconds are rejected as stale (replay hardening).
  // 0 disables the check. Defaults to 0 (off) for backward compatibility.
  messageMaxAgeSeconds?: number;
  // Optional sink for operational events (lockouts, permanent send failures).
  eventNotifier?: EventNotifier;
};

type QueuedMessage = {
  storedId: string;
  user: AuthorizedUser;
  phoneE164: string;
  senderPhone: VersionedHash;
  text: string;
  externalMessageId: string | null;
  messageType: string | null;
};

// Message types whose text content is meaningful to the assistant. Anything
// else (media, contacts, locations, ...) gets a fixed notice instead of an
// LLM round-trip over a "[image]" placeholder.
const SUPPORTED_TEXT_TYPES = new Set(["text", "button", "interactive"]);

type QueuedWork = {
  message: QueuedMessage;
  alreadyClaimed: boolean;
};

type AcceptedMessage =
  | {
      result: Exclude<
        ProcessingResult,
        "queued" | "processed" | "delivery_unknown" | "failed"
      >;
    }
  | { result: "queued"; queued: QueuedMessage };

export class MessageProcessor {
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly pendingQueue: QueuedWork[] = [];
  private readonly workerConcurrency: number;
  private readonly maxBufferedJobs: number;
  private readonly userRateLimit: number;
  private readonly ingressSenderRateLimit: number;
  private readonly ingressGlobalRateLimit: number;
  private pumpScheduled = false;
  private consecutivePermanentSendFailures = 0;
  private lastMetaErrorCode: number | null = null;
  private lockedOutSenders = 0;
  private readonly locale: AssistantLocale;
  private readonly abuseLockoutThreshold: number;
  private readonly messageMaxAgeSeconds: number;
  private readonly eventNotifier: EventNotifier;

  constructor(private readonly options: MessageProcessorOptions) {
    this.userRateLimit = options.rateLimitPerMinute ?? 20;
    this.ingressSenderRateLimit = options.ingressSenderRateLimitPerMinute ?? 10;
    this.ingressGlobalRateLimit = options.ingressGlobalRateLimitPerMinute ?? 600;
    this.workerConcurrency = options.workerConcurrency ?? 4;
    this.locale = options.locale ?? "en";
    this.abuseLockoutThreshold = options.abuseLockoutThreshold ?? 10;
    this.messageMaxAgeSeconds = options.messageMaxAgeSeconds ?? 0;
    this.eventNotifier = options.eventNotifier ?? new NoopEventNotifier();
    if (!Number.isInteger(this.abuseLockoutThreshold) || this.abuseLockoutThreshold < 1) {
      throw new Error("Abuse lockout threshold must be a positive integer");
    }
    if (!Number.isInteger(this.messageMaxAgeSeconds) || this.messageMaxAgeSeconds < 0) {
      throw new Error("Message max age must be a non-negative integer");
    }
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
    const globalSubject = this.options.identifiers.hash("global", "rate-limit-global").hash;
    if (!(await this.consumeLimit("whatsapp.ingress-global", globalSubject, this.ingressGlobalRateLimit))) {
      return;
    }
    const message = await updateStatus.call(
      this.options.messages,
      update.externalMessageId,
      update.status
    );
    if (!message) return;
    const errorCodes = (update.errors ?? []).map((statusError) => statusError.code);
    if (update.status === "failed" && errorCodes.length > 0) {
      logSafe(
        this.options.logger,
        "warn",
        {
          userId: message.userId,
          messageId: message.id,
          metaErrorCodes: errorCodes,
          hints: errorCodes.map((code) => metaErrorHint(code, 0))
        },
        "Meta reported the outbound WhatsApp message as failed"
      );
    }
    await this.options.audit.record({
      userId: message.userId,
      eventType: "whatsapp.delivery_status",
      outcome: update.status === "failed" ? "failure" : "success",
      messageId: message.id,
      details: {
        status: update.status,
        ...(errorCodes.length > 0 ? { metaErrorCodes: errorCodes } : {})
      }
    });
  }

  // Delivery health for the /health endpoint: a run of permanent send
  // failures means the Meta-side configuration is broken, not the service.
  deliveryHealth(): { consecutivePermanentSendFailures: number; lastMetaErrorCode: number | null } {
    return {
      consecutivePermanentSendFailures: this.consecutivePermanentSendFailures,
      lastMetaErrorCode: this.lastMetaErrorCode
    };
  }

  // Running count of sender lockouts triggered since boot, for the /health
  // endpoint and operational visibility.
  securityHealth(): { lockedOutSenders: number } {
    return { lockedOutSenders: this.lockedOutSenders };
  }

  // Fresh iff the check is enabled and the Meta timestamp (unix seconds) is
  // within the configured window. Fail open on an unparseable timestamp so a
  // format change on Meta's side never silently drops real traffic.
  private isFresh(timestamp: string): boolean {
    if (this.messageMaxAgeSeconds <= 0) return true;
    const epochSeconds = Number(timestamp);
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return true;
    const nowSeconds = Date.now() / 1000;
    return Math.abs(nowSeconds - epochSeconds) <= this.messageMaxAgeSeconds;
  }

  private async registerLockout(subjectHash: string, globalSubject: string): Promise<void> {
    this.lockedOutSenders += 1;
    // Only non-reversible references leave the process.
    this.eventNotifier.notify({ type: "sender.locked_out", details: { senderHash: subjectHash } });
    if (await this.consumeLimit("whatsapp.lockout-audit", globalSubject, 5)) {
      await this.options.audit.record({
        eventType: "whatsapp.lockout",
        outcome: "denied",
        details: { reason: "abuse_threshold_exceeded" }
      });
      logSafe(
        this.options.logger,
        "warn",
        {},
        "Locked out a WhatsApp sender after repeated unauthorized messages"
      );
    }
  }

  private recoveredMessage(pending: PendingInboundMessage, identity: AuthorizedUserIdentity): QueuedMessage {
    return {
      storedId: pending.id,
      user: identity.user,
      phoneE164: identity.phoneE164,
      senderPhone: { hash: pending.senderPhoneHash, keyId: pending.senderPhoneKeyId },
      text: pending.content ?? "",
      externalMessageId: null,
      messageType: null
    };
  }

  private async accept(incoming: IncomingWhatsAppMessage): Promise<AcceptedMessage> {
    const normalizedPhone = normalizePhoneNumber(incoming.from, this.options.defaultCountry);
    const phoneForHash = normalizedPhone ?? incoming.from;
    const senderPhone = this.options.identifiers.hash(phoneForHash, "sender-phone");
    const rateSubject = this.options.identifiers.hash(phoneForHash, "rate-limit-subject").hash;
    const globalSubject = this.options.identifiers.hash("global", "rate-limit-global").hash;

    // Replay hardening: a captured webhook re-delivered later carries its
    // original Meta timestamp. Drop anything outside the freshness window
    // before spending any rate-limit budget or touching storage.
    if (!this.isFresh(incoming.timestamp)) {
      if (await this.consumeLimit("whatsapp.security-audit", globalSubject, 5)) {
        await this.options.audit.record({
          eventType: "whatsapp.replay_rejected",
          outcome: "denied",
          details: { reason: "stale_timestamp" }
        });
        logSafe(this.options.logger, "warn", {}, "Dropped a WhatsApp webhook message with a stale timestamp");
      }
      return { result: "stale" };
    }

    const ingressAllowed = await this.consumeLimit(
      "whatsapp.ingress-global",
      globalSubject,
      this.ingressGlobalRateLimit
    );
    const senderAllowed = ingressAllowed
      ? await this.consumeLimit("whatsapp.ingress-sender", rateSubject, this.ingressSenderRateLimit)
      : false;
    if (!ingressAllowed || !senderAllowed) {
      return { result: "rate_limited" };
    }
    const user = normalizedPhone ? await this.options.users.findActiveByPhone(normalizedPhone) : null;

    if (!user || !normalizedPhone) {
      // Repeated unauthorized traffic from one sender within the window trips a
      // lockout: the sender is silently ignored (no reply, no engagement) and
      // the event is escalated so operators/integrations can react to probing.
      if (!(await this.consumeLimit("whatsapp.abuse-sender", rateSubject, this.abuseLockoutThreshold))) {
        await this.registerLockout(rateSubject, globalSubject);
        return { result: "unauthorized" };
      }
      if (await this.consumeLimit("whatsapp.security-audit", globalSubject, 5)) {
        await this.options.audit.record({
          eventType: "whatsapp.authorization",
          outcome: "denied",
          details: { reason: "not_whitelisted" }
        });
        logSafe(
          this.options.logger,
          "warn",
          {},
          "Ignored WhatsApp message from a non-whitelisted sender"
        );
      }
      return { result: "unauthorized" };
    }

    const stored = await this.options.messages.saveInbound({
      externalMessageId: incoming.externalMessageId,
      userId: user.id,
      content: incoming.text,
      senderPhone,
      messageType: incoming.type
    });

    if (stored.status !== "received" && stored.status !== "failed") return { result: "duplicate" };
    return {
      result: "queued",
      queued: {
        storedId: stored.id,
        user,
        phoneE164: normalizedPhone,
        senderPhone,
        text: incoming.text,
        externalMessageId: incoming.externalMessageId,
        messageType: incoming.type
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

    const userRateSubject = this.options.identifiers.hash(queued.user.id, "rate-limit-user").hash;
    if (!(await this.consumeLimit("whatsapp.user", userRateSubject, this.userRateLimit))) {
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
      void this.sendNoticeOncePerMinute(queued, "rateLimited", userRateSubject);
      return "rate_limited";
    }

    this.acknowledgeInbound(queued);

    try {
      const command =
        queued.messageType !== null && !SUPPORTED_TEXT_TYPES.has(queued.messageType)
          ? {
              text: systemMessage("unsupportedType", this.localeFor(queued.user)),
              resource: null,
              resources: [],
              outcome: "unsupported" as const
            }
          : await this.options.router.handle(queued.user, queued.text, {
              messageId: queued.storedId,
              ...(await this.conversationHistory(queued))
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
      this.consecutivePermanentSendFailures = 0;
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
      // If the failure happened before/without a send attempt (LLM crash, DB
      // error, ...) the user would otherwise face pure silence. A send-layer
      // failure is excluded: the apology would fail identically.
      if (!this.isSendLayerError(error)) {
        const userRateSubject = this.options.identifiers.hash(queued.user.id, "rate-limit-user").hash;
        void this.sendNoticeOncePerMinute(queued, "processingFailed", userRateSubject);
      }
      return "failed";
    }
  }

  private localeFor(user: AuthorizedUser): AssistantLocale {
    return user.locale ?? this.locale;
  }

  // Best-effort short-term memory for the assistant; failures degrade to a
  // context-free answer rather than blocking the reply.
  private async conversationHistory(queued: QueuedMessage): Promise<{ history?: ConversationTurn[] }> {
    const recent = this.options.messages.recentConversation;
    if (!recent) return {};
    try {
      const entries = await recent.call(this.options.messages, queued.user.id, queued.storedId, 6);
      if (entries.length === 0) return {};
      return {
        history: entries.map((entry) => ({
          direction: entry.direction,
          text: entry.content.slice(0, 1_000)
        }))
      };
    } catch (error) {
      logSafe(
        this.options.logger,
        "debug",
        { error, userId: queued.user.id, messageId: queued.storedId },
        "Conversation history could not be loaded"
      );
      return {};
    }
  }

  private isSendLayerError(error: unknown): boolean {
    return (
      error instanceof WhatsAppApiError ||
      error instanceof WhatsAppDeliveryUncertainError ||
      isPermanentSendError(error)
    );
  }

  // Best-effort user notice, capped at one per key per minute per user so a
  // burst of failures or rate-limited spam cannot echo notice floods back.
  private async sendNoticeOncePerMinute(
    queued: QueuedMessage,
    key: "rateLimited" | "processingFailed",
    subjectHash: string
  ): Promise<void> {
    try {
      if (!(await this.options.rateLimits.consume(`whatsapp.notice.${key}`, subjectHash, 1))) return;
      await this.options.sender.sendText(queued.phoneE164, systemMessage(key, this.localeFor(queued.user)));
    } catch (error) {
      logSafe(
        this.options.logger,
        "debug",
        { error, userId: queued.user.id, messageId: queued.storedId },
        "Best-effort user notice could not be sent"
      );
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
        senderPhone: queued.senderPhone,
        status: "sent"
      });
      return "sent";
    }

    const reservation = await reserve.call(this.options.messages, {
      replyToMessageId: queued.storedId,
      userId: queued.user.id,
      content: command.text,
      senderPhone: queued.senderPhone
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

  // Best-effort read receipt + typing indicator; never allowed to affect the
  // reply pipeline.
  private acknowledgeInbound(queued: QueuedMessage): void {
    const markRead = this.options.sender.markRead;
    if (!markRead || !queued.externalMessageId) return;
    void markRead.call(this.options.sender, queued.externalMessageId).catch((error: unknown) => {
      logSafe(
        this.options.logger,
        "debug",
        { error, userId: queued.user.id, messageId: queued.storedId },
        "WhatsApp read receipt could not be sent"
      );
    });
  }

  private async markUnexpectedFailure(messageId: string, userId: string, error: unknown): Promise<void> {
    // A permanently rejected send (expired token, recipient not allowed, ...)
    // will fail identically on every retry, so take the message out of the
    // recovery loop instead of burning attempts every 10 seconds.
    const permanent = isPermanentSendError(error);
    const metaErrorCode = error instanceof WhatsAppApiError ? error.loggableDetails.metaErrorCode : null;
    if (error instanceof WhatsAppApiError && error.permanent) {
      this.consecutivePermanentSendFailures += 1;
      this.lastMetaErrorCode = metaErrorCode;
      this.eventNotifier.notify({
        type: "send.permanent_failure",
        details: { ...(metaErrorCode !== null ? { metaErrorCode } : {}) }
      });
    }
    const markUndeliverable = this.options.messages.markInboundUndeliverable;
    if (permanent && markUndeliverable) {
      await markUndeliverable.call(this.options.messages, messageId).catch(() => undefined);
    } else {
      await this.options.messages.setInboundStatus(messageId, "failed").catch(() => undefined);
    }
    await this.options.audit
      .record({
        userId,
        eventType: "whatsapp.processing",
        outcome: "failure",
        messageId,
        details: {
          errorType: error instanceof Error ? error.name : "UnknownError",
          terminal: permanent,
          ...(metaErrorCode !== null ? { metaErrorCode } : {})
        }
      })
      .catch(() => undefined);
    logSafe(
      this.options.logger,
      "error",
      { error, userId, messageId },
      "WhatsApp message processing failed"
    );
  }

  private async consumeLimit(scope: string, subjectHash: string, capacity: number): Promise<boolean> {
    try {
      return await this.options.rateLimits.consume(scope, subjectHash, capacity);
    } catch (error) {
      logSafe(this.options.logger, "error", { error, scope }, "Distributed rate limiter failed closed");
      return false;
    }
  }
}
