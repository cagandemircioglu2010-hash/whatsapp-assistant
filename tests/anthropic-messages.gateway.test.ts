import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicMessagesGateway,
  toAnthropicMessages
} from "../src/llm/anthropic-messages.gateway.js";

describe("Anthropic Messages gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps user, assistant tool-use, and tool-result turns to native messages", () => {
    const messages = toAnthropicMessages({
      instructions: "Use company tools.",
      safetyIdentifier: "safe-id",
      tools: [],
      inputItems: [
        { role: "user", content: [{ type: "input_text", text: "Satış özeti" }] },
        {
          type: "anthropic_native_message",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_sales_summary",
              input: { start_date: "2026-07-01", end_date: "2026-07-31" }
            }
          ]
        },
        {
          type: "function_call_output",
          call_id: "toolu_1",
          output: "{\"sales\":5}"
        }
      ]
    });

    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Satış özeti" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "get_sales_summary",
            input: { start_date: "2026-07-01", end_date: "2026-07-31" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "{\"sales\":5}"
          }
        ]
      }
    ]);
  });

  it("uses Sonnet-compatible settings and returns native tool calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "get_sales_summary",
              input: { start_date: "2026-07-01", end_date: "2026-07-31" }
            }
          ],
          stop_reason: "tool_use"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const gateway = new AnthropicMessagesGateway({
      apiKey: "anthropic-test-key",
      model: "claude-sonnet-5",
      maxOutputTokens: 700,
      timeoutMs: 5_000
    });

    const turn = await gateway.createTurn({
      instructions: "Use company tools.",
      inputItems: [{ role: "user", content: [{ type: "input_text", text: "Satışlar" }] }],
      tools: [
        {
          type: "function",
          name: "get_sales_summary",
          description: "Sales summary",
          parameters: {
            type: "object",
            properties: { start_date: { type: "string" }, end_date: { type: "string" } },
            required: ["start_date", "end_date"],
            additionalProperties: false
          },
          strict: true
        }
      ],
      safetyIdentifier: "hashed-user-id"
    });

    expect(turn.functionCalls).toEqual([
      {
        callId: "toolu_2",
        name: "get_sales_summary",
        arguments: "{\"start_date\":\"2026-07-01\",\"end_date\":\"2026-07-31\"}"
      }
    ]);
    const [endpoint, init] = fetchMock.mock.calls[0]!;
    expect(endpoint).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "x-api-key": "anthropic-test-key",
        "anthropic-version": "2023-06-01"
      })
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system: "Use company tools.",
      thinking: { type: "disabled" },
      metadata: { user_id: "hashed-user-id" },
      tool_choice: { type: "auto" }
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body.tools).toEqual([
      expect.objectContaining({
        name: "get_sales_summary",
        strict: true,
        input_schema: expect.objectContaining({ type: "object" })
      })
    ]);
  });

  it("returns text, omits tools when unavailable, and surfaces safe HTTP failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "Merhaba!" }], stop_reason: "end_turn" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const gateway = new AnthropicMessagesGateway({
      apiKey: "anthropic-test-key",
      model: "claude-sonnet-5",
      maxOutputTokens: 700,
      timeoutMs: 5_000
    });
    const request = {
      instructions: "Answer safely.",
      inputItems: [{ role: "user", content: [{ type: "input_text", text: "Selam" }] }],
      tools: [],
      safetyIdentifier: "safe-id"
    };

    await expect(gateway.createTurn(request)).resolves.toMatchObject({
      outputText: "Merhaba!",
      functionCalls: []
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");

    fetchMock.mockResolvedValueOnce(new Response("provider failure", { status: 429 }));
    await expect(gateway.createTurn(request)).rejects.toThrow("status 429");
  });
});
