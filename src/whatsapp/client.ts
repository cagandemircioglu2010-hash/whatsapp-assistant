import type { WhatsAppSender } from "./types.js";

type WhatsAppClientConfig = {
  accessToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
};

export class WhatsAppClient implements WhatsAppSender {
  constructor(private readonly config: WhatsAppClientConfig) {}

  async sendText(to: string, text: string): Promise<{ externalMessageId: string }> {
    const response = await fetch(
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
          text: { preview_url: false, body: text }
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );

    if (!response.ok) {
      throw new Error(`WhatsApp API request failed with status ${response.status}`);
    }

    const body = (await response.json()) as { messages?: Array<{ id?: string }> };
    const externalMessageId = body.messages?.[0]?.id;
    if (!externalMessageId) throw new Error("WhatsApp API response did not include a message id");
    return { externalMessageId };
  }
}
