import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from "openai/resources/chat/completions/completions.js";
import type { LlmFunctionTool, LlmGateway, LlmTurn, LlmTurnRequest } from "./types.js";

type GeminiChatCompletionsGatewayOptions = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

type GeminiReplayItem = {
  type: "gemini_chat_message";
  message: ChatCompletionAssistantMessageParam;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponsesUserItem(value: unknown): value is ResponsesUserItem {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content)) return false;
  return value.content.every(
    (part) => isRecord(part) && part.type === "input_text" && typeof part.text === "string"
  );
}

function isGeminiReplayItem(value: unknown): value is GeminiReplayItem {
  return isRecord(value) && value.type === "gemini_chat_message" && isRecord(value.message);
}

function isFunctionCallOutputItem(value: unknown): value is FunctionCallOutputItem {
  return (
    isRecord(value) &&
    value.type === "function_call_output" &&
    typeof value.call_id === "string" &&
    typeof value.output === "string"
  );
}

export function toGeminiChatMessages(request: LlmTurnRequest): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: request.instructions }
  ];

  for (const item of request.inputItems) {
    if (isResponsesUserItem(item)) {
      messages.push({
        role: "user",
        content: item.content.map((part) => part.text).join("\n")
      });
      continue;
    }
    if (isGeminiReplayItem(item)) {
      messages.push(item.message);
      continue;
    }
    if (isFunctionCallOutputItem(item)) {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    }
  }

  return messages;
}

export function toGeminiChatTools(tools: LlmFunctionTool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters
    }
  }));
}

export class GeminiChatCompletionsGateway implements LlmGateway {
  private readonly client: OpenAI;

  constructor(private readonly options: GeminiChatCompletionsGatewayOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
      maxRetries: 2,
      timeout: options.timeoutMs
    });
  }

  async createTurn(request: LlmTurnRequest): Promise<LlmTurn> {
    const completion = await this.client.chat.completions.create(
      {
        model: this.options.model,
        messages: toGeminiChatMessages(request),
        tools: toGeminiChatTools(request.tools),
        tool_choice: "auto",
        max_tokens: this.options.maxOutputTokens
      },
      { signal: AbortSignal.timeout(this.options.timeoutMs) }
    );
    const message = completion.choices[0]?.message;
    if (!message) throw new Error("Gemini returned no completion choice");

    const functionCalls = (message.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => ({
        callId: call.id,
        name: call.function.name,
        arguments: call.function.arguments
      }));
    const replayMessage: ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: message.content,
      ...(functionCalls.length > 0
        ? {
            tool_calls: functionCalls.map((call) => ({
              id: call.callId,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments }
            }))
          }
        : {})
    };

    return {
      outputText: message.content ?? "",
      replayItems: [{ type: "gemini_chat_message", message: replayMessage } satisfies GeminiReplayItem],
      functionCalls
    };
  }
}
