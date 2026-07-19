export type IncomingWhatsAppMessage = {
  externalMessageId: string;
  from: string;
  type: string;
  text: string;
  timestamp: string;
};

export type WhatsAppStatusError = {
  code: number;
  title: string | null;
};

export type WhatsAppMessageStatus = {
  externalMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  errors?: WhatsAppStatusError[];
};

export interface WhatsAppSender {
  sendText(to: string, text: string): Promise<{ externalMessageId: string }>;
  markRead?(externalMessageId: string): Promise<void>;
}
