import type { AuthorizedUser } from "../auth/types.js";

export type AssistantContext = {
  messageId: string;
};

export type AssistantResponse = {
  text: string;
  resource: string | null;
  resources: string[];
  outcome: "success" | "denied" | "unsupported";
};

export interface AssistantResponder {
  handle(user: AuthorizedUser, incomingText: string, context: AssistantContext): Promise<AssistantResponse>;
}
