import type { LlmFunctionTool, LlmGateway, LlmTurn, LlmTurnRequest } from "./types.js";

type AnthropicMessagesGatewayOptions = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | Record<string, unknown>;

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicReplayItem = {
  type: "anthropic_native_message";
  content: AnthropicContentBlock[];
};

type ResponsesUserItem = {
  role: "user";
  content: Array<{ type: "input_text"; text: string }>;
};

type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

type AnthropicMessagesResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponsesUserItem(value: unknown): value is ResponsesUserItem {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) return false;
  return value.content.every(
    (part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string"
  );
}

function isFunctionCallOutputItem(value: unknown): value is FunctionCallOutputItem {
  return (
    isRecord(value) &&
    value.type === "function_call_output" &&
    typeof value.call_id === "string" &&
    typeof value.output === "string"
  );
}

function isAnthropicReplayItem(value: unknown): value is AnthropicReplayItem {
  return (
    isRecord(value) &&
    value.type === "anthropic_native_message" &&
    Array.isArray(value.content)
  );
}

function addMessage(
  messages: AnthropicMessage[],
  role: AnthropicMessage["role"],
  content: AnthropicContentBlock[]
): void {
  if (content.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.content.push(...content);
  } else {
    messages.push({ role, content: [...content] });
  }
}

export function toAnthropicMessages(request: LlmTurnRequest): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const item of request.inputItems) {
    if (isResponsesUserItem(item)) {
      addMessage(
        messages,
        "user",
        item.content.map((part) => ({ type: "text", text: part.text }))
      );
      continue;
    }
    if (isAnthropicReplayItem(item)) {
      addMessage(messages, "assistant", item.content);
      continue;
    }
    if (isFunctionCallOutputItem(item)) {
      addMessage(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: item.output
        }
      ]);
    }
  }
  return messages;
}

function toAnthropicTools(tools: LlmFunctionTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
    strict: tool.strict
  }));
}

function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === "text" && typeof block.text === "string";
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    isRecord(block.input)
  );
}

export class AnthropicMessagesGateway implements LlmGateway {
  constructor(private readonly options: AnthropicMessagesGatewayOptions) {}

  async createTurn(request: LlmTurnRequest): Promise<LlmTurn> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxOutputTokens,
        system: request.instructions,
        messages: toAnthropicMessages(request),
        ...(request.tools.length > 0
          ? {
              tools: toAnthropicTools(request.tools),
              tool_choice: { type: "auto" }
            }
          : {}),
        // Sonnet 5 enables adaptive thinking by default. Disabling it keeps the
        // existing WhatsApp output-token budget focused on the visible answer.
        thinking: { type: "disabled" },
        metadata: { user_id: request.safetyIdentifier }
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      const details = (await response.text()).replace(/\s+/g, " ").slice(0, 1_000);
      throw new Error(
        `Anthropic API request failed with status ${response.status}${details ? `: ${details}` : ""}`
      );
    }

    const payload = (await response.json()) as AnthropicMessagesResponse;
    if (!Array.isArray(payload.content)) {
      throw new Error(`Anthropic returned no message content (${payload.stop_reason ?? "unknown"})`);
    }

    const content = payload.content;
    const outputText = content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    const functionCalls = content.filter(isToolUseBlock).map((block) => ({
      callId: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input)
    }));

    if (!outputText && functionCalls.length === 0) {
      throw new Error(`Anthropic returned no text or tool call (${payload.stop_reason ?? "unknown"})`);
    }

    return {
      outputText,
      replayItems: [
        { type: "anthropic_native_message", content } satisfies AnthropicReplayItem
      ],
      functionCalls
    };
  }
}
