import { describe, expect, it } from "vitest";
import { FallbackAssistantResponder } from "../src/assistant/fallback-responder.js";
import type { AssistantResponder, AssistantResponse } from "../src/assistant/types.js";
import { createLogger } from "../src/logging/logger.js";

const context = { messageId: "message-1" };

function response(outcome: AssistantResponse["outcome"], text: string): AssistantResponse {
  return { outcome, text, resource: null, resources: [] };
}

describe("fallback assistant responder", () => {
  it("uses a locale-aware temporary-failure message when general chat fails", async () => {
    const primary: AssistantResponder = {
      handle: async () => {
        throw new Error("provider unavailable");
      }
    };
    const deterministic: AssistantResponder = {
      handle: async () => response("unsupported", "business menu")
    };
    const fallback = new FallbackAssistantResponder(
      primary,
      deterministic,
      createLogger("silent"),
      (user) => (user.locale === "en" ? "Please try again shortly." : "Lütfen tekrar deneyin.")
    );

    await expect(
      fallback.handle(
        { id: "user-en", department: null, role: "employee", locale: "en" },
        "general question",
        context
      )
    ).resolves.toEqual(response("unsupported", "Please try again shortly."));
  });

  it("still returns a deterministic report when the LLM fails", async () => {
    const primary: AssistantResponder = {
      handle: async () => {
        throw new Error("provider unavailable");
      }
    };
    const deterministic: AssistantResponder = {
      handle: async () => ({
        outcome: "success",
        text: "Aktif projeler",
        resource: "company.projects",
        resources: ["company.projects"]
      })
    };
    const fallback = new FallbackAssistantResponder(
      primary,
      deterministic,
      createLogger("silent"),
      "temporary failure"
    );

    await expect(
      fallback.handle(
        { id: "user-tr", department: "Engineering", role: "employee", locale: "tr" },
        "aktif projeler",
        context
      )
    ).resolves.toMatchObject({
      outcome: "success",
      resource: "company.projects",
      text: "Aktif projeler"
    });
  });
});
