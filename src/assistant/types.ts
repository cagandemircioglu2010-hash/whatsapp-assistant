import type { AuthorizedUser } from "../auth/types.js";

export type ConversationTurn = {
  direction: "inbound" | "outbound";
  text: string;
};

export type AssistantContext = {
  messageId: string;
  // Recent decrypted exchanges (oldest first), so the LLM can resolve
  // follow-ups like "peki geciken görevler?". Absent when history is
  // unavailable (recovery path, retention already purged, plain router).
  history?: ConversationTurn[];
};

export type AssistantResponse = {
  text: string;
  resource: string | null;
  resources: string[];
  outcome: "success" | "denied" | "unsupported";
  // Conversation responses use no company data tool and are audited
  // separately from permission-checked business/report operations.
  kind?: "business" | "conversation";
};

export interface AssistantResponder {
  handle(user: AuthorizedUser, incomingText: string, context: AssistantContext): Promise<AssistantResponse>;
}
