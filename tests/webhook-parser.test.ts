import { describe, expect, it } from "vitest";
import {
  parseIncomingMessages,
  parseMessageStatusUpdates
} from "../src/whatsapp/webhook-parser.js";

describe("WhatsApp webhook parser", () => {
  it("extracts inbound text messages and ignores status-only events", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: "wamid.123",
                    from: "905551234567",
                    timestamp: "1700000000",
                    type: "text",
                    text: { body: "Aktif projeler" }
                  }
                ]
              }
            },
            { value: { statuses: [{ id: "wamid.outbound", status: "delivered" }] } }
          ]
        }
      ]
    };

    expect(parseIncomingMessages(payload)).toEqual([
      {
        externalMessageId: "wamid.123",
        from: "905551234567",
        timestamp: "1700000000",
        type: "text",
        text: "Aktif projeler"
      }
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseIncomingMessages(null)).toEqual([]);
    expect(parseIncomingMessages({ entry: "invalid" })).toEqual([]);
  });

  it("extracts and bounds outbound delivery status updates", () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: "wamid.out", status: "delivered", timestamp: "1700000001" },
                  { id: "wamid.out", status: "delivered", timestamp: "1700000001" },
                  { id: "wamid.bad", status: "invented", timestamp: "1700000002" }
                ]
              }
            }
          ]
        }
      ]
    };
    expect(parseMessageStatusUpdates(payload)).toEqual([
      { externalMessageId: "wamid.out", status: "delivered", timestamp: "1700000001" }
    ]);
  });
});
