import { describe, expect, it } from "vitest";
import {
  toGeminiChatMessages,
  toGeminiChatTools
} from "../src/llm/gemini-chat-completions.gateway.js";

describe("Gemini chat completions gateway", () => {
  it("maps the company tool loop to OpenAI-compatible Gemini messages", () => {
    const messages = toGeminiChatMessages({
      instructions: "Use company tools only.",
      safetyIdentifier: "identifier",
      tools: [],
      inputItems: [
        { role: "user", content: [{ type: "input_text", text: "Satış özeti" }] },
        {
          type: "gemini_chat_message",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_sales_summary", arguments: "{}" }
              }
            ]
          }
        },
        { type: "function_call_output", call_id: "call-1", output: "{\"sales\":5}" }
      ]
    });

    expect(messages).toEqual([
      { role: "system", content: "Use company tools only." },
      { role: "user", content: "Satış özeti" },
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] }),
      { role: "tool", tool_call_id: "call-1", content: "{\"sales\":5}" }
    ]);
  });

  it("maps MCP schemas to Gemini-compatible function tools", () => {
    expect(
      toGeminiChatTools([
        {
          type: "function",
          name: "get_sales_summary",
          description: "Sales summary",
          parameters: { type: "object", properties: {} },
          strict: true
        }
      ])
    ).toEqual([
      {
        type: "function",
        function: {
          name: "get_sales_summary",
          description: "Sales summary",
          parameters: { type: "object", properties: {} }
        }
      }
    ]);
  });
});
