import { describe, expect, it, vi } from "vitest";
import { WhatsAppClient, WhatsAppDeliveryUncertainError } from "../src/whatsapp/client.js";

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("WhatsApp API client", () => {
  it("sends a bounded text request without exposing the token in errors", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      response(200, { messages: [{ id: "wamid.out" }] })
    );
    const client = new WhatsAppClient({
      accessToken: "secret-access-token-that-must-not-leak",
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      fetchFn
    });

    await expect(client.sendText("+905551234567", "  Merhaba  ")).resolves.toEqual({
      externalMessageId: "wamid.out"
    });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-access-token-that-must-not-leak" });
    expect(JSON.parse(String(init.body))).toMatchObject({ to: "+905551234567", text: { body: "Merhaba" } });
  });

  it("retries explicit transient HTTP failures with a bounded delay", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, { error: "busy" }, { "retry-after": "1" }))
      .mockResolvedValueOnce(response(200, { messages: [{ id: "wamid.retry" }] }));
    const sleep = vi.fn(async () => undefined);
    const client = new WhatsAppClient({
      accessToken: "x".repeat(30),
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      fetchFn,
      sleep
    });

    await expect(client.sendText("905551234567", "Durum")).resolves.toEqual({
      externalMessageId: "wamid.retry"
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("marks network failures as delivery-uncertain instead of retrying blindly", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket closed"));
    const client = new WhatsAppClient({
      accessToken: "x".repeat(30),
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      fetchFn
    });

    await expect(client.sendText("905551234567", "Durum")).rejects.toBeInstanceOf(
      WhatsAppDeliveryUncertainError
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry ambiguous server failures that could duplicate a message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(503, { error: "upstream" }));
    const client = new WhatsAppClient({
      accessToken: "x".repeat(30),
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      fetchFn
    });

    await expect(client.sendText("905551234567", "Durum")).rejects.toBeInstanceOf(
      WhatsAppDeliveryUncertainError
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("treats an unusable success response as delivery-uncertain", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response(200, { messages: [] }));
    const client = new WhatsAppClient({
      accessToken: "x".repeat(30),
      phoneNumberId: "123456789",
      graphApiVersion: "v25.0",
      fetchFn
    });

    await expect(client.sendText("905551234567", "Durum")).rejects.toBeInstanceOf(
      WhatsAppDeliveryUncertainError
    );
  });
});
