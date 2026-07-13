import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type {
  FunctionTool,
  ResponseInput,
  ResponseOutputItem
} from "openai/resources/responses/responses.js";
import type { LlmGateway, LlmTurn, LlmTurnRequest } from "./types.js";

type OpenAIResponsesGatewayOptions = {
  apiKey: string;
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  maxOutputTokens: number;
  timeoutMs: number;
};

export class OpenAIResponsesGateway implements LlmGateway {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIResponsesGatewayOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, maxRetries: 2, timeout: options.timeoutMs });
  }

  async createTurn(request: LlmTurnRequest): Promise<LlmTurn> {
    const response = await this.client.responses.create(
      {
        model: this.options.model,
        instructions: request.instructions,
        input: request.inputItems as ResponseInput,
        tools: request.tools as FunctionTool[],
        tool_choice: "auto",
        parallel_tool_calls: true,
        reasoning: { effort: this.options.reasoningEffort, context: "current_turn" },
        max_output_tokens: this.options.maxOutputTokens,
        store: false,
        include: ["reasoning.encrypted_content"],
        safety_identifier: request.safetyIdentifier,
        metadata: { channel: "whatsapp", assistant: "company-reporting" }
      },
      { signal: AbortSignal.timeout(this.options.timeoutMs) }
    );

    const functionCalls = response.output
      .filter((item): item is Extract<ResponseOutputItem, { type: "function_call" }> => item.type === "function_call")
      .map((item) => ({ callId: item.call_id, name: item.name, arguments: item.arguments }));

    return {
      outputText: response.output_text,
      replayItems: toResponseInputItems(response.output),
      functionCalls
    };
  }
}
