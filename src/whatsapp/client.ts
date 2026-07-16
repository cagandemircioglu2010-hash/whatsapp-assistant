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

export class WhatsAppDeliveryUncertainError extends Error {
  constructor() {
    super("WhatsApp delivery result is unknown");
    this.name = "WhatsAppDeliveryUncertainError";
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 5000);
  return Math.min(250 * 2 ** attempt, 2000);
}

export class WhatsAppClient implements WhatsAppSender {
  constructor(private readonly config: WhatsAppClientConfig) {}

  async sendText(to: string, text: string): Promise<{ externalMessageId: string }> {
    if (!/^\+?[1-9]\d{7,14}$/.test(to)) throw new Error("WhatsApp recipient is invalid");
    const normalizedText = text.trim();
    if (!normalizedText || normalizedText.length > 4096) throw new Error("WhatsApp text must be 1-4096 characters");

    const fetchFn = this.config.fetchFn ?? fetch;
    const sleep = this.config.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const maxRetries = Math.min(Math.max(this.config.maxRetries ?? 2, 0), 4);
    let response: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await fetchFn(
          `https://graph.facebook.com/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to,
              type: "text",
              text: { preview_url: false, body: normalizedText }
            }),
            signal: AbortSignal.timeout(10_000)
          }
        );
      } catch {
        throw new WhatsAppDeliveryUncertainError();
      }

      if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === maxRetries) break;
      await sleep(retryDelay(response, attempt));
    }

    if (response && UNCERTAIN_STATUSES.has(response.status)) {
      throw new WhatsAppDeliveryUncertainError();
    }
    if (!response?.ok) {
      throw new Error(`WhatsApp API request failed with status ${response?.status ?? "unknown"}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
      throw new WhatsAppDeliveryUncertainError();
    }
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch {
      throw new WhatsAppDeliveryUncertainError();
    }
    if (rawBody.length > 65_536) throw new WhatsAppDeliveryUncertainError();
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
