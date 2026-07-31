import { describe, expect, it } from "vitest";
import {
  GatewayRequestClassifier,
  type RequestClassification
} from "../src/llm/request-classifier.js";
import type { LlmGateway, LlmTurnRequest } from "../src/llm/types.js";

class ClassifierGateway implements LlmGateway {
  readonly requests: LlmTurnRequest[] = [];

  constructor(
    private readonly output: string,
    private readonly functionCalls: Array<{
      callId: string;
      name: string;
      arguments: string;
    }> = []
  ) {}

  async createTurn(request: LlmTurnRequest) {
    this.requests.push(structuredClone(request));
    return {
      outputText: this.output,
      replayItems: [],
      functionCalls: this.functionCalls
    };
  }
}

describe("gateway request classifier", () => {
  it.each<RequestClassification>([
    "GENERAL",
    "COMPANY_CLEAR",
    "COMPANY_NEEDS_CLARIFICATION",
    "SECURITY_SENSITIVE"
  ])("accepts the exact strict label %s", async (label) => {
    const gateway = new ClassifierGateway(label);
    const classifier = new GatewayRequestClassifier(gateway);

    await expect(
      classifier.classify({
        text: "Uncertain request",
        safetyIdentifier: "safe-id"
      })
    ).resolves.toBe(label);

    expect(gateway.requests[0]).toMatchObject({
      tools: [],
      toolChoice: "auto",
      maxOutputTokens: 64,
      safetyIdentifier: "safe-id"
    });
    expect(gateway.requests[0]?.instructions).toContain("Return exactly one label");
  });

  it.each([
    "GENERAL.",
    "\"GENERAL\"",
    "The label is GENERAL",
    "general",
    "",
    "COMPANY_CLEAR\nGENERAL"
  ])("rejects non-enum classifier output: %j", async (output) => {
    const classifier = new GatewayRequestClassifier(new ClassifierGateway(output));
    await expect(
      classifier.classify({ text: "Question", safetyIdentifier: "safe-id" })
    ).rejects.toThrow("invalid label");
  });

  it("rejects any classifier tool call", async () => {
    const classifier = new GatewayRequestClassifier(
      new ClassifierGateway("COMPANY_CLEAR", [
        { callId: "call-1", name: "query_database", arguments: "{}" }
      ])
    );
    await expect(
      classifier.classify({ text: "Question", safetyIdentifier: "safe-id" })
    ).rejects.toThrow("attempted a tool call");
  });
});
