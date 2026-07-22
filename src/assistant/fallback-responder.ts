import type { Logger } from "pino";
import { logSafe } from "../logging/logger.js";
import type { AssistantContext, AssistantResponder, AssistantResponse } from "./types.js";
import type { AuthorizedUser } from "../auth/types.js";

export class FallbackAssistantResponder implements AssistantResponder {
  constructor(
    private readonly primary: AssistantResponder,
    private readonly fallback: AssistantResponder,
    private readonly logger: Logger,
    private readonly unsupportedFallbackText?: string | ((user: AuthorizedUser) => string)
  ) {}

  async handle(
    user: AuthorizedUser,
    incomingText: string,
    context: AssistantContext
  ): Promise<AssistantResponse> {
    try {
      return await this.primary.handle(user, incomingText, context);
    } catch (error) {
      logSafe(
        this.logger,
        "error",
        { error, userId: user.id, messageId: context.messageId },
        "LLM assistant failed; using deterministic fallback"
      );
      const response = await this.fallback.handle(user, incomingText, context);
      if (response.outcome !== "unsupported" || !this.unsupportedFallbackText) return response;
      const text =
        typeof this.unsupportedFallbackText === "function"
          ? this.unsupportedFallbackText(user)
          : this.unsupportedFallbackText;
      return { ...response, text };
    }
  }
}
