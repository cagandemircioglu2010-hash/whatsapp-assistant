import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import { logSafe } from "../logging/logger.js";

// Operational events worth forwarding to an external system (Slack relay, SIEM,
// on-call tooling). Payloads carry no message content or personal data — only
// non-reversible references and coarse operational facts — so a downstream
// integration can never become a new exfiltration path.
export type IntegrationEventType =
  | "sender.locked_out"
  | "send.permanent_failure";

export type IntegrationEvent = {
  type: IntegrationEventType;
  // Coarse, non-reversible context only (hashes, Meta error codes, counts).
  details?: Record<string, string | number | boolean>;
};

export interface EventNotifier {
  // Fire-and-forget: notifying an external system must never block or fail the
  // WhatsApp pipeline, so this returns void and swallows every error internally.
  notify(event: IntegrationEvent): void;
}

// Used whenever no integration URL is configured (the default). Keeps call
// sites unconditional so the pipeline never branches on "is integration on".
export class NoopEventNotifier implements EventNotifier {
  notify(_event: IntegrationEvent): void {
    // Intentionally does nothing.
  }
}

export type SignedHttpEventNotifierOptions = {
  url: string;
  secret: string;
  logger: Logger;
  timeoutMs?: number;
  // Injectable for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
  now?: () => number;
};

// Signature header: the receiver recomputes HMAC-SHA256 over the exact request
// body with the shared secret and compares in constant time. The timestamp is
// inside the signed body, so a captured delivery cannot be replayed against a
// receiver that enforces freshness.
export const INTEGRATION_SIGNATURE_HEADER = "x-assistant-signature";
export const INTEGRATION_TIMESTAMP_HEADER = "x-assistant-timestamp";

export function signIntegrationPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyIntegrationSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signIntegrationPayload(secret, body));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export class SignedHttpEventNotifier implements EventNotifier {
  private readonly url: string;
  private readonly secret: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: SignedHttpEventNotifierOptions) {
    this.url = options.url;
    this.secret = options.secret;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  notify(event: IntegrationEvent): void {
    const task = this.deliver(event).catch((error: unknown) => {
      logSafe(this.logger, "warn", { error, eventType: event.type }, "Integration event delivery failed");
    });
    // Track the promise so shutdown can await outstanding deliveries.
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async deliver(event: IntegrationEvent): Promise<void> {
    const timestamp = Math.floor(this.now() / 1000);
    const body = JSON.stringify({
      type: event.type,
      timestamp,
      details: event.details ?? {}
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTEGRATION_TIMESTAMP_HEADER]: String(timestamp),
          [INTEGRATION_SIGNATURE_HEADER]: signIntegrationPayload(this.secret, body)
        },
        body,
        signal: controller.signal
      });
      if (!response.ok) {
        logSafe(
          this.logger,
          "warn",
          { eventType: event.type, status: response.status },
          "Integration endpoint rejected the event"
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
