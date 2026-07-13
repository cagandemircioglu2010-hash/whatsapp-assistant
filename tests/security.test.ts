import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPhoneIdentifier, normalizePhoneNumber, phoneLastFour } from "../src/security/phone.js";
import { redactString, sanitizeForLogs } from "../src/security/redact.js";
import { verifyMetaSignature } from "../src/whatsapp/signature.js";

describe("phone security", () => {
  it("normalizes Turkish phone numbers to E.164", () => {
    expect(normalizePhoneNumber("0555 123 45 67", "TR")).toBe("+905551234567");
    expect(phoneLastFour("+905551234567")).toBe("4567");
  });

  it("creates deterministic non-plaintext phone hashes", () => {
    const hash = hashPhoneIdentifier("+905551234567", "a".repeat(32));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain("5551234567");
    expect(hash).toBe(hashPhoneIdentifier("+905551234567", "a".repeat(32)));
  });
});

describe("log redaction", () => {
  it("removes nested sensitive fields and inline identifiers", () => {
    const result = sanitizeForLogs({
      messageId: "wamid.123",
      phoneNumber: "+90 555 123 45 67",
      nested: {
        content: "internal company message",
        note: "Contact person@example.com or use Bearer secret-token"
      }
    });

    expect(result).toEqual({
      messageId: "wamid.123",
      phoneNumber: "[REDACTED]",
      nested: { content: "[REDACTED]", note: "Contact [REDACTED] or use [REDACTED]" }
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
