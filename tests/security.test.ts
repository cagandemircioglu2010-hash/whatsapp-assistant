import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePhoneNumber } from "../src/security/phone.js";
import { parseHmacKeyRing, VersionedHmac } from "../src/security/keyed-hash.js";
import { redactString, sanitizeForLogs } from "../src/security/redact.js";
import { verifyMetaSignature } from "../src/whatsapp/signature.js";

describe("phone security", () => {
  it("normalizes Turkish phone numbers to E.164", () => {
    expect(normalizePhoneNumber("0555 123 45 67", "TR")).toBe("+905551234567");
  });

  it("supports ordered HMAC key rotation without accepting duplicate key material", () => {
    const current = Buffer.alloc(32, 7).toString("base64");
    const old = Buffer.alloc(32, 8).toString("base64");
    const hmac = new VersionedHmac(
      parseHmacKeyRing(JSON.stringify({ old, current }), "current")
    );
    const candidates = hmac.candidates("+905551234567", "phone-identifier");
    expect(candidates.map((candidate) => candidate.keyId)).toEqual(["current", "old"]);
    expect(hmac.verify("+905551234567", "phone-identifier", candidates[1]!.hash, "old")).toBe(true);
    expect(() =>
      parseHmacKeyRing(JSON.stringify({ current, duplicate: current }), "current")
    ).toThrow("unique");
  });
});

describe("log redaction", () => {
  it("removes nested sensitive fields and inline identifiers", () => {
    const result = sanitizeForLogs({
      messageId: "wamid.123",
      phoneNumber: "+90 555 123 45 67",
      nested: {
        content: "internal company message",
        note: "Contact person@example.com or use Bearer secret-token",
        openaiApiKey: "must-not-appear"
      },
      packet: Buffer.from("binary secret")
    });

    expect(result).toEqual({
      messageId: "[REDACTED]",
      phoneNumber: "[REDACTED]",
      nested: {
        content: "[REDACTED]",
        note: "Contact [REDACTED] or use [REDACTED]",
        openaiApiKey: "[REDACTED]"
      },
      packet: "[REDACTED_BINARY]"
    });
    expect(redactString("postgresql://admin:secret@db.local/company")).toBe("[REDACTED]");
  });
});

describe("Meta webhook signature", () => {
  it("accepts only the matching HMAC signature", () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const secret = "meta-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyMetaSignature(raw, signature, secret)).toBe(true);
    expect(verifyMetaSignature(raw, signature, "wrong-secret")).toBe(false);
    expect(verifyMetaSignature(raw, undefined, secret)).toBe(false);
  });
});
