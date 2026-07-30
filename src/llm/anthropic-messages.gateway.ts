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

type AnthropicErrorResponse = {
  error?: {
    type?: string;
  };
};

const allowedAnthropicErrorTypes = new Set([
  "api_error",
  "authentication_error",
  "billing_error",
  "invalid_request_error",
  "not_found_error",
  "overloaded_error",
  "permission_error",
  "rate_limit_error",
  "request_too_large",
  "timeout_error"
]);

function safeAnthropicErrorType(value: unknown): string {
  return typeof value === "string" && allowedAnthropicErrorTypes.has(value)
    ? value
    : "unknown_error";
}

export class AnthropicApiError extends Error {
  readonly loggableDetails: {
    provider: "anthropic";
    status: number;
    errorType: string;
  };

  constructor(status: number, errorType: unknown) {
    const safeErrorType = safeAnthropicErrorType(errorType);
    super(`Anthropic API request failed with status ${status} (${safeErrorType})`);
    this.name = "AnthropicApiError";
    this.loggableDetails = {
      provider: "anthropic",
      status,
      errorType: safeErrorType
    };
  }
}

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

const unsupportedAnthropicStrictSchemaKeywords = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems"
]);
const forbiddenSchemaPointerTokens = new Set(["__proto__", "prototype", "constructor"]);
const MAX_ANTHROPIC_SCHEMA_DEPTH = 64;
const MAX_ANTHROPIC_SCHEMA_NODES = 10_000;

function schemaPointerTokens(reference: string): string[] {
  if (!reference.startsWith("#/")) {
    throw new Error("Anthropic tool schemas only support local JSON Schema references");
  }
  return reference
    .slice(2)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolveSchemaReference(root: unknown, reference: string): unknown {
  let current = root;
  for (const token of schemaPointerTokens(reference)) {
    if (forbiddenSchemaPointerTokens.has(token)) {
      throw new Error("Anthropic tool schema reference contains a forbidden path");
    }
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) {
        throw new Error("Anthropic tool schema reference contains an invalid array index");
      }
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new Error("Anthropic tool schema reference cannot be resolved");
    }
    if (current === undefined) {
      throw new Error("Anthropic tool schema reference cannot be resolved");
    }
  }
  return current;
}

function normalizeAnthropicToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  let visitedNodes = 0;
  const visit = (
    value: unknown,
    referenceStack: readonly string[],
    depth: number
  ): unknown => {
    if (depth > MAX_ANTHROPIC_SCHEMA_DEPTH || ++visitedNodes > MAX_ANTHROPIC_SCHEMA_NODES) {
      throw new Error("Anthropic tool schema exceeds the normalization budget");
    }
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, referenceStack, depth + 1));
    }
    if (!isRecord(value)) return value;

    if (typeof value.$ref === "string") {
      const reference = value.$ref;
      if (Object.keys(value).some((key) => key !== "$ref")) {
        throw new Error("Anthropic tool schema references cannot have sibling keywords");
      }
      if (referenceStack.includes(reference)) {
        throw new Error("Anthropic tool schema contains a circular reference");
      }
      return visit(
        resolveSchemaReference(schema, reference),
        [...referenceStack, reference],
        depth + 1
      );
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenSchemaPointerTokens.has(key)) {
        throw new Error("Anthropic tool schema contains a forbidden key");
      }
      // Anthropic strict tool use rejects numeric bounds and array-size
      // keywords. The MCP/Zod boundary still enforces every original bound
      // before any company tool can execute.
      if (unsupportedAnthropicStrictSchemaKeywords.has(key)) continue;
      normalized[key] = visit(item, referenceStack, depth + 1);
    }
    return normalized;
  };

  const normalized = visit(schema, [], 0);
  if (!isRecord(normalized)) {
    throw new Error("Anthropic tool input schema must be an object");
  }
  return normalized;
}

function toAnthropicTools(tools: LlmFunctionTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: normalizeAnthropicToolSchema(tool.parameters),
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
      const responseText = await response.text();
      let errorType: unknown = "unknown_error";
      try {
        const payload = JSON.parse(responseText) as AnthropicErrorResponse;
        errorType = payload.error?.type;
      } catch {
        // Free-form provider bodies are intentionally excluded from production
        // logs. The status plus a bounded structured type are sufficient for
        // operations without risking prompt, credential, or user-data leakage.
      }
      throw new AnthropicApiError(response.status, errorType);
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
