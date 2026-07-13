export type LlmFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};

export type LlmFunctionCall = {
  callId: string;
  name: string;
  arguments: string;
};

export type LlmTurnRequest = {
  instructions: string;
  inputItems: unknown[];
  tools: LlmFunctionTool[];
  safetyIdentifier: string;
};

export type LlmTurn = {
  outputText: string;
  replayItems: unknown[];
  functionCalls: LlmFunctionCall[];
};

export interface LlmGateway {
  createTurn(request: LlmTurnRequest): Promise<LlmTurn>;
}
