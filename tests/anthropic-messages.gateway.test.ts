import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicApiError,
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

  it("normalizes MCP schemas to Anthropic's strict-tool subset without mutating them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "44" }],
          stop_reason: "end_turn"
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
    const parameters = {
      type: "object",
      properties: {
        columns: {
          type: "array",
          items: { type: "string", maxLength: 127 },
          maxItems: 12
        },
        primary_column: { $ref: "#/properties/columns/items" },
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      required: ["columns", "primary_column", "limit"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#"
    };

    await expect(
      gateway.createTurn({
        instructions: "Answer safely.",
        inputItems: [
          { role: "user", content: [{ type: "input_text", text: "14 + 30 kaç?" }] }
        ],
        tools: [
          {
            type: "function",
            name: "query_database",
            parameters,
            strict: true
          }
        ],
        toolChoice: "required",
        maxOutputTokens: 64,
        safetyIdentifier: "safe-id"
      })
    ).resolves.toMatchObject({ outputText: "44" });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      max_tokens: number;
      tools: Array<{ input_schema: Record<string, unknown> }>;
    };
    const schema = body.tools[0]!.input_schema;
    expect(body.max_tokens).toBe(64);
    expect(body).toMatchObject({ tool_choice: { type: "any" } });
    expect(schema).toMatchObject({
      properties: {
        columns: {
          type: "array",
          items: { type: "string", maxLength: 127 }
        },
        primary_column: { type: "string", maxLength: 127 },
        limit: { type: "integer" }
      }
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /"\$ref"|"minimum"|"maximum"|"minItems"|"maxItems"/
    );
    expect(parameters).toMatchObject({
      properties: {
        columns: { maxItems: 12 },
        primary_column: { $ref: "#/properties/columns/items" },
        limit: { minimum: 1, maximum: 50 }
      }
    });
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

    const providerDetail = "provider detail must not be copied into the application error";
    const expectSafeFailure = async (
      responseBody: string,
      expectedErrorType: string
    ): Promise<void> => {
      fetchMock.mockResolvedValueOnce(
        new Response(responseBody, {
          status: 429,
          headers: { "Content-Type": "application/json" }
        })
      );
      const failure = await gateway.createTurn(request).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AnthropicApiError);
      expect(failure).toMatchObject({
        message: `Anthropic API request failed with status 429 (${expectedErrorType})`,
        loggableDetails: {
          provider: "anthropic",
          status: 429,
          errorType: expectedErrorType
        }
      });
      expect(String(failure)).not.toContain(providerDetail);
    };

    await expectSafeFailure(
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: providerDetail }
      }),
      "rate_limit_error"
    );
    for (const unsafeType of [
      "",
      "unrecognized_provider_error",
      `invalid_request_error${providerDetail.repeat(8)}`
    ]) {
      await expectSafeFailure(
        JSON.stringify({
          type: "error",
          error: { type: unsafeType, message: providerDetail }
        }),
        "unknown_error"
      );
    }
    await expectSafeFailure(providerDetail, "unknown_error");
  });
});
