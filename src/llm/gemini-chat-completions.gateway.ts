import { randomUUID } from "node:crypto";
import type { LlmFunctionTool, LlmGateway, LlmTurn, LlmTurnRequest } from "./types.js";

type GeminiGenerateContentGatewayOptions = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

type GeminiFunctionCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: {
    id: string;
    name: string;
    response: Record<string, unknown>;
  };
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiReplayItem = {
  type: "gemini_native_content";
  content: GeminiContent;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
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
  return (
    isRecord(value) &&
    value.type === "gemini_native_content" &&
    isRecord(value.content) &&
    (value.content.role === "user" || value.content.role === "model") &&
    Array.isArray(value.content.parts)
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

function functionResponsePayload(output: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(output);
    return { result: parsed };
  } catch {
    return { result: output };
  }
}

function normalizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeGeminiSchema);
  if (!isRecord(value)) return value;

  if (
    Array.isArray(value.anyOf) &&
    value.anyOf.length === 2 &&
    value.anyOf.some((candidate) => isRecord(candidate) && candidate.type === "null")
  ) {
    const nonNull = value.anyOf.find((candidate) => !(isRecord(candidate) && candidate.type === "null"));
    if (isRecord(nonNull)) {
      const normalized = normalizeGeminiSchema(nonNull);
      return isRecord(normalized)
        ? { ...normalized, ...(typeof value.description === "string" ? { description: value.description } : {}), nullable: true }
        : normalized;
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["$schema", "additionalProperties", "pattern", "minLength", "maxLength"].includes(key)) continue;
    normalized[key] = normalizeGeminiSchema(child);
  }
  return normalized;
}

export function toGeminiNativeContents(request: LlmTurnRequest): GeminiContent[] {
  const callNames = new Map<string, string>();
  for (const item of request.inputItems) {
    if (!isGeminiReplayItem(item)) continue;
    for (const part of item.content.parts) {
      const call = part.functionCall;
      if (call?.id) callNames.set(call.id, call.name);
    }
  }

  const contents: GeminiContent[] = [];
  let pendingFunctionResponses: GeminiPart[] = [];
  const flushFunctionResponses = () => {
    if (pendingFunctionResponses.length === 0) return;
    contents.push({ role: "user", parts: pendingFunctionResponses });
    pendingFunctionResponses = [];
  };

  for (const item of request.inputItems) {
    if (isResponsesUserItem(item)) {
      flushFunctionResponses();
      contents.push({
        role: "user",
        parts: [{ text: item.content.map((part) => part.text).join("\n") }]
      });
      continue;
    }
    if (isGeminiReplayItem(item)) {
      flushFunctionResponses();
      contents.push(item.content);
      continue;
    }
    if (isFunctionCallOutputItem(item)) {
      const name = callNames.get(item.call_id);
      if (!name) throw new Error("Gemini function response is missing its function name");
      pendingFunctionResponses.push({
        functionResponse: {
          id: item.call_id,
          name,
          response: functionResponsePayload(item.output)
        }
      });
    }
  }
  flushFunctionResponses();
  return contents;
}

export function toGeminiNativeTools(tools: LlmFunctionTool[]) {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: normalizeGeminiSchema(tool.parameters) as Record<string, unknown>
      }))
    }
  ];
}

function normalizeCandidateContent(content: GeminiContent): GeminiContent {
  return {
    role: "model",
    parts: content.parts.map((part) => {
      if (!part.functionCall || part.functionCall.id) return part;
      return {
        ...part,
        functionCall: { ...part.functionCall, id: `gemini-${randomUUID()}` }
      };
    })
  };
}

export class GeminiChatCompletionsGateway implements LlmGateway {
  constructor(private readonly options: GeminiGenerateContentGatewayOptions) {}

  async createTurn(request: LlmTurnRequest): Promise<LlmTurn> {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.options.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.instructions }] },
        contents: toGeminiNativeContents(request),
        tools: toGeminiNativeTools(request.tools),
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        generationConfig: { maxOutputTokens: this.options.maxOutputTokens }
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      const details = (await response.text()).replace(/\s+/g, " ").slice(0, 1_000);
      throw new Error(`Gemini API request failed with status ${response.status}${details ? `: ${details}` : ""}`);
    }

    const payload = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = payload.candidates?.[0];
    if (!candidate?.content) {
      const reason = payload.promptFeedback?.blockReason ?? candidate?.finishReason ?? "unknown";
      throw new Error(`Gemini returned no completion candidate (${reason})`);
    }

    const content = normalizeCandidateContent(candidate.content);
    const functionCalls = content.parts.flatMap((part) => {
      const call = part.functionCall;
      return call
        ? [{ callId: call.id!, name: call.name, arguments: JSON.stringify(call.args ?? {}) }]
        : [];
    });
    const outputText = content.parts
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    return {
      outputText,
      replayItems: [{ type: "gemini_native_content", content } satisfies GeminiReplayItem],
      functionCalls
    };
  }
}
