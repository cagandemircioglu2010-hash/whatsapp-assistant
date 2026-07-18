import { redactString } from "../security/redact.js";
import { classifyMetaError, metaErrorHint, type MetaErrorClassification } from "./meta-errors.js";
import type { WhatsAppSender } from "./types.js";

type WhatsAppClientConfig = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
};

// A 429 explicitly rejects the request and is safe to retry. Timeouts and 5xx
// responses can arrive after a side effect, so treat them as delivery-unknown.
const RETRYABLE_STATUSES = new Set([429]);
const UNCERTAIN_STATUSES = new Set([408, 500, 502, 503, 504]);
const MAX_BODY_BYTES = 65_536;
const MESSAGE_CHARACTER_LIMIT = 4096;
const MAX_MESSAGE_CHUNKS = 8;

export class WhatsAppDeliveryUncertainError extends Error {
  constructor() {
    super("WhatsApp delivery result is unknown");
    this.name = "WhatsAppDeliveryUncertainError";
  }
}

export type WhatsAppApiErrorDetails = {
  httpStatus: number;
  metaErrorCode: number | null;
  metaErrorSubcode: number | null;
  fbtraceId: string | null;
  apiMessage: string | null;
  hint: string;
  classification: MetaErrorClassification;
};

export class WhatsAppApiError extends Error {
  // Structured, PII-free fields the production log sanitizer is allowed to emit.
  readonly loggableDetails: WhatsAppApiErrorDetails;

  constructor(details: WhatsAppApiErrorDetails) {
    super(
      `WhatsApp API request failed with status ${details.httpStatus}` +
        (details.metaErrorCode !== null ? ` (Meta error ${details.metaErrorCode})` : "")
    );
    this.name = "WhatsAppApiError";
    this.loggableDetails = details;
  }

  get permanent(): boolean {
    return this.loggableDetails.classification === "permanent";
  }
}

export class WhatsAppSendValidationError extends Error {
  readonly loggableDetails: { reason: string; classification: "permanent" };

  constructor(reason: string) {
    super(`WhatsApp send request is invalid: ${reason}`);
    this.name = "WhatsAppSendValidationError";
    this.loggableDetails = { reason, classification: "permanent" };
  }
}

export function isPermanentSendError(error: unknown): boolean {
  if (error instanceof WhatsAppSendValidationError) return true;
  return error instanceof WhatsAppApiError && error.permanent;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 5000);
  return Math.min(250 * 2 ** attempt, 2000);
}

function boundedInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99_999_999
    ? value
    : null;
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value)
    ? value
    : null;
}

async function readBoundedBody(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return null;
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    return null;
  }
  return rawBody.length > MAX_BODY_BYTES ? null : rawBody;
}

async function errorFromResponse(response: Response): Promise<WhatsAppApiError> {
  let code: number | null = null;
  let subcode: number | null = null;
  let fbtraceId: string | null = null;
  let apiMessage: string | null = null;

  const rawBody = await readBoundedBody(response);
  if (rawBody) {
    try {
      const body = JSON.parse(rawBody) as unknown;
      const error =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as { error?: unknown }).error
          : null;
      if (error !== null && typeof error === "object" && !Array.isArray(error)) {
        const errorRecord = error as Record<string, unknown>;
        code = boundedInteger(errorRecord.code);
        subcode = boundedInteger(errorRecord.error_subcode);
        fbtraceId = boundedIdentifier(errorRecord.fbtrace_id);
        if (typeof errorRecord.message === "string") {
          apiMessage = redactString(errorRecord.message).slice(0, 300);
        }
      }
    } catch {
      // Non-JSON error bodies carry no usable detail; keep the HTTP status only.
    }
  }

  return new WhatsAppApiError({
    httpStatus: response.status,
    metaErrorCode: code,
    metaErrorSubcode: subcode,
    fbtraceId,
    apiMessage,
    hint: metaErrorHint(code, response.status),
    classification: classifyMetaError(code, response.status)
  });
}

// Splits long replies on paragraph, line, then word boundaries so every chunk
// fits WhatsApp's per-message limit.
export function splitWhatsAppText(text: string, limit = MESSAGE_CHARACTER_LIMIT): string[] {
  const normalized = text.trim();
  if (normalized.length <= limit) return normalized ? [normalized] : [];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const breakpoint = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
      (index) => index >= Math.floor(limit / 2)
    );
    const cut = breakpoint !== undefined ? breakpoint : limit;
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class WhatsAppClient implements WhatsAppSender {
  constructor(private readonly config: WhatsAppClientConfig) {}

  async sendText(to: string, text: string): Promise<{ externalMessageId: string }> {
    if (!/^\+?[1-9]\d{7,14}$/.test(to)) throw new WhatsAppSendValidationError("recipient_invalid");
    const chunks = splitWhatsAppText(text);
    if (chunks.length === 0) throw new WhatsAppSendValidationError("text_empty");
    if (chunks.length > MAX_MESSAGE_CHUNKS) throw new WhatsAppSendValidationError("text_too_long");

    let lastMessageId: string | null = null;
    for (const chunk of chunks) {
      const sent = await this.sendSingleText(to, chunk);
      lastMessageId = sent.externalMessageId;
    }
    return { externalMessageId: lastMessageId! };
  }

  // Marks an inbound message as read and shows a typing indicator. Cosmetic
  // only: callers must treat failures as non-fatal.
  async markRead(externalMessageId: string): Promise<void> {
    const fetchFn = this.config.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(this.messagesUrl(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: externalMessageId,
          typing_indicator: { type: "text" }
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new WhatsAppDeliveryUncertainError();
    }
    if (!response.ok) throw await errorFromResponse(response);
    await readBoundedBody(response);
  }

  // Boot-time sanity check: confirms the token can read the configured phone
  // number. Returns safe, non-PII metadata for logging.
  async verifyConfiguration(): Promise<{ verifiedName: string | null; qualityRating: string | null }> {
    const fetchFn = this.config.fetchFn ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(
        `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}?fields=verified_name,quality_rating`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
          signal: AbortSignal.timeout(10_000)
        }
      );
    } catch {
      throw new WhatsAppDeliveryUncertainError();
    }
    if (!response.ok) throw await errorFromResponse(response);
    const rawBody = await readBoundedBody(response);
    let verifiedName: string | null = null;
    let qualityRating: string | null = null;
    if (rawBody) {
      try {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        verifiedName = typeof body.verified_name === "string" ? body.verified_name.slice(0, 120) : null;
        qualityRating = typeof body.quality_rating === "string" ? body.quality_rating.slice(0, 40) : null;
      } catch {
        // A malformed success body still proves the token/number pair works.
      }
    }
    return { verifiedName, qualityRating };
  }

  private messagesUrl(): string {
    return `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.accessToken}`,
      "Content-Type": "application/json"
    };
  }

  private async sendSingleText(to: string, text: string): Promise<{ externalMessageId: string }> {
    const fetchFn = this.config.fetchFn ?? fetch;
    const sleep = this.config.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const maxRetries = Math.min(Math.max(this.config.maxRetries ?? 2, 0), 4);
    let response: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await fetchFn(this.messagesUrl(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { preview_url: false, body: text }
          }),
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        throw new WhatsAppDeliveryUncertainError();
      }

      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) break;
      await sleep(retryDelay(response, attempt));
    }

    if (response && UNCERTAIN_STATUSES.has(response.status)) {
      throw new WhatsAppDeliveryUncertainError();
    }
    if (!response) throw new WhatsAppDeliveryUncertainError();
    if (!response.ok) throw await errorFromResponse(response);

    const rawBody = await readBoundedBody(response);
    if (rawBody === null) throw new WhatsAppDeliveryUncertainError();
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new WhatsAppDeliveryUncertainError();
    }
    const messages =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { messages?: unknown }).messages
        : null;
    const firstMessage = Array.isArray(messages) ? messages[0] : null;
    const externalMessageId =
      firstMessage !== null && typeof firstMessage === "object" && !Array.isArray(firstMessage)
        ? (firstMessage as { id?: unknown }).id
        : null;
    if (
      typeof externalMessageId !== "string" ||
      !externalMessageId ||
      externalMessageId.length > 512 ||
      /[\u0000-\u001F\u007F]/.test(externalMessageId)
    ) {
      throw new WhatsAppDeliveryUncertainError();
    }
    return { externalMessageId };
  }
}
