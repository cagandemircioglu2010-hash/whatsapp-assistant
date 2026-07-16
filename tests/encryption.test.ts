import { describe, expect, it } from "vitest";
import {
  EnvelopeEncryption,
  parseDataEncryptionConfig
} from "../src/security/encryption.js";

function encoded(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64");
}

describe("AES-256-GCM envelope encryption", () => {
  it("round-trips content with randomized nonces and authenticated purpose binding", () => {
    const encryption = new EnvelopeEncryption(
      parseDataEncryptionConfig(JSON.stringify({ current: encoded(1) }), "current")
    );
    const first = encryption.encrypt("sensitive company message", "messages.content", "messages:one");
    const second = encryption.encrypt("sensitive company message", "messages.content", "messages:one");

    expect(first.ciphertext).not.toContain("sensitive company message");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(encryption.decrypt(first.ciphertext, "messages.content", "messages:one")).toBe(
      "sensitive company message"
    );
    expect(() => encryption.decrypt(first.ciphertext, "users.phone", "messages:one")).toThrow(
      "authentication"
    );
    expect(() => encryption.decrypt(first.ciphertext, "messages.content", "messages:two")).toThrow(
      "authentication"
    );
  });

  it("detects tampering and supports decrypting an older rotated key", () => {
    const oldEncryption = new EnvelopeEncryption(
      parseDataEncryptionConfig(JSON.stringify({ old: encoded(2) }), "old")
    );
    const protectedValue = oldEncryption.encrypt("+905551234567", "users.phone", "users:one");
    const rotated = new EnvelopeEncryption(
      parseDataEncryptionConfig(JSON.stringify({ current: encoded(3), old: encoded(2) }), "current")
    );

    expect(rotated.decrypt(protectedValue.ciphertext, "users.phone", "users:one")).toBe(
      "+905551234567"
    );
    const parts = protectedValue.ciphertext.split(".");
    const encryptedBytes = Buffer.from(parts[3]!, "base64url");
    encryptedBytes[0] = encryptedBytes[0]! ^ 1;
    parts[3] = encryptedBytes.toString("base64url");
    const tampered = parts.join(".");
    expect(() => rotated.decrypt(tampered, "users.phone", "users:one")).toThrow("authentication");
  });

  it("rejects malformed or undersized key rings", () => {
    expect(() => parseDataEncryptionConfig("{}", "missing")).toThrow();
    expect(() =>
      parseDataEncryptionConfig(JSON.stringify({ current: Buffer.alloc(16).toString("base64") }), "current")
    ).toThrow("32 bytes");
    expect(() =>
      parseDataEncryptionConfig(
        JSON.stringify({ current: encoded(4), duplicate: encoded(4) }),
        "current"
      )
    ).toThrow("unique");
  });
});
