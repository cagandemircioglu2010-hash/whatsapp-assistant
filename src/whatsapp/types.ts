export type IncomingWhatsAppMessage = {
  externalMessageId: string;
  from: string;
  type: string;
  text: string;
  timestamp: string;
};

export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<{ externalMessageId: string }>;
}
