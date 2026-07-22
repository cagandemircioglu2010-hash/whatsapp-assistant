import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiChatCompletionsGateway,
  toGeminiNativeContents,
  toGeminiNativeTools
} from "../src/llm/gemini-chat-completions.gateway.js";

describe("Gemini native generateContent gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps the company tool loop to native Gemini contents", () => {
    const contents = toGeminiNativeContents({
      instructions: "Use company tools only.",
      safetyIdentifier: "identifier",
      tools: [],
      inputItems: [
        { role: "user", content: [{ type: "input_text", text: "Satış özeti" }] },
        {
          type: "gemini_native_content",
          content: {
            role: "model",
            parts: [
              {
                thoughtSignature: "signature",
                functionCall: { id: "call-1", name: "get_sales_summary", args: {} }
              }
            ]
          }
        },
        { type: "function_call_output", call_id: "call-1", output: "{\"sales\":5}" }
      ]
    });

    expect(contents).toEqual([
      { role: "user", parts: [{ text: "Satış özeti" }] },
      {
        role: "model",
        parts: [
          {
            thoughtSignature: "signature",
            functionCall: { id: "call-1", name: "get_sales_summary", args: {} }
          }
        ]
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "get_sales_summary",
              response: { result: { sales: 5 } }
            }
          }
        ]
      }
    ]);
  });

  it("maps nullable MCP schemas to Gemini function declarations", () => {
    expect(
      toGeminiNativeTools([
        {
          type: "function",
          name: "get_active_projects",
          parameters: {
            type: "object",
            properties: {
              limit: {
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                description: "Limit"
              }
            },
            additionalProperties: false,
            $schema: "http://json-schema.org/draft-07/schema#"
          },
          strict: true
        }
      ])
    ).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_active_projects",
            parameters: {
              type: "object",
              properties: {
                limit: { type: "integer", minimum: 1, description: "Limit", nullable: true }
              }
            }
          }
        ]
      }
    ]);
  });

  it("authenticates native Gemini requests with x-goog-api-key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "get_sales_summary", args: { days: 7 } } }]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const gateway = new GeminiChatCompletionsGateway({
      apiKey: "AQ.secret",
      model: "gemini-3.5-flash",
      maxOutputTokens: 500,
      timeoutMs: 5_000
    });

    const turn = await gateway.createTurn({
      instructions: "Use tools.",
      inputItems: [{ role: "user", content: [{ type: "input_text", text: "Sales" }] }],
      tools: [],
      safetyIdentifier: "identifier"
    });

    expect(turn.functionCalls).toEqual([
      expect.objectContaining({ name: "get_sales_summary", arguments: "{\"days\":7}" })
    ]);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual(
      expect.objectContaining({ "x-goog-api-key": "AQ.secret" })
    );
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("omits function-calling fields when a user has no authorized tools", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "Merhaba!" }] } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const gateway = new GeminiChatCompletionsGateway({
      apiKey: "AQ.secret",
      model: "gemini-3.5-flash",
      maxOutputTokens: 500,
      timeoutMs: 5_000
    });

    const turn = await gateway.createTurn({
      instructions: "Answer general questions safely.",
      inputItems: [{ role: "user", content: [{ type: "input_text", text: "Merhaba" }] }],
      tools: [],
      safetyIdentifier: "identifier"
    });

    expect(turn.outputText).toBe("Merhaba!");
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("toolConfig");
  });

  it.each([401, 429, 500])("surfaces Gemini HTTP %i failures for safe fallback", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider failure", { status }));
    const gateway = new GeminiChatCompletionsGateway({
      apiKey: "AQ.secret",
      model: "gemini-3.5-flash",
      maxOutputTokens: 500,
      timeoutMs: 5_000
    });

    await expect(
      gateway.createTurn({
        instructions: "Answer safely.",
        inputItems: [{ role: "user", content: [{ type: "input_text", text: "Merhaba" }] }],
        tools: [],
        safetyIdentifier: "identifier"
      })
    ).rejects.toThrow(`status ${status}`);
  });

  it("surfaces network and safety-block failures for safe fallback", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockRejectedValueOnce(new TypeError("network unavailable"));
    const gateway = new GeminiChatCompletionsGateway({
      apiKey: "AQ.secret",
      model: "gemini-3.5-flash",
      maxOutputTokens: 500,
      timeoutMs: 5_000
    });
    const request = {
      instructions: "Answer safely.",
      inputItems: [{ role: "user", content: [{ type: "input_text", text: "Merhaba" }] }],
      tools: [],
      safetyIdentifier: "identifier"
    };

    await expect(gateway.createTurn(request)).rejects.toThrow("network unavailable");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(gateway.createTurn(request)).rejects.toThrow("SAFETY");
  });
});
