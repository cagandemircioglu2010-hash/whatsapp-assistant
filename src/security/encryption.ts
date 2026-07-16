import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "v1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const MAX_ENVELOPE_BYTES = 1_000_000;

export type DataEncryptionConfig = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export type EncryptedValue = {
  ciphertext: string;
  keyId: string;
};

function decodeKey(value: unknown): Buffer {
  if (typeof value !== "string" || !BASE64_PATTERN.test(value)) {
    throw new Error("Encryption keys must be base64 strings");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("Each encryption key must decode to exactly 32 bytes");
  }
  return decoded;
}

export function parseDataEncryptionConfig(keysJson: string, activeKeyId: string): DataEncryptionConfig {
  if (!KEY_ID_PATTERN.test(activeKeyId)) throw new Error("The active encryption key id is invalid");

  let parsed: unknown;
  try {
    parsed = JSON.parse(keysJson);
  } catch {
    throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DATA_ENCRYPTION_KEYS must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 8) {
    throw new Error("DATA_ENCRYPTION_KEYS must contain between 1 and 8 keys");
  }

  const keys = new Map<string, Buffer>();
  for (const [keyId, encodedKey] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error("An encryption key id is invalid");
    keys.set(keyId, decodeKey(encodedKey));
  }
  if (!keys.has(activeKeyId)) throw new Error("The active encryption key id is missing from the key ring");
  return { activeKeyId, keys };
}

function aad(version: string, purpose: string, keyId: string): Buffer {
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(purpose)) throw new Error("Encryption purpose is invalid");
  return Buffer.from(`${version}\u0000${purpose}\u0000${keyId}`, "utf8");
}

function decodeEnvelopePart(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new Error("Encrypted value is malformed");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("Encrypted value is malformed");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error("Encrypted value is malformed");
  }
  return decoded;
}

export class EnvelopeEncryption {
  constructor(private readonly config: DataEncryptionConfig) {}

  encrypt(plaintext: string, purpose: string): EncryptedValue {
    const keyId = this.config.activeKeyId;
    const key = this.config.keys.get(keyId);
    if (!key) throw new Error("Active encryption key is unavailable");

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(ENVELOPE_VERSION, purpose, keyId));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyId,
      ciphertext: [
        ENVELOPE_VERSION,
        keyId,
        iv.toString("base64url"),
        encrypted.toString("base64url"),
        tag.toString("base64url")
      ].join(".")
    };
  }

  decrypt(envelope: string, purpose: string): string {
    if (Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new Error("Encrypted value is too large");
    }
    const parts = envelope.split(".");
    if (parts.length !== 5) throw new Error("Encrypted value is malformed");
    const [version, keyId, encodedIv, encodedCiphertext, encodedTag] = parts;
    if (version !== ENVELOPE_VERSION || !keyId || !KEY_ID_PATTERN.test(keyId)) {
      throw new Error("Encrypted value is malformed");
    }
    const key = this.config.keys.get(keyId);
    if (!key) throw new Error(`Encryption key '${keyId}' is unavailable`);

    const iv = decodeEnvelopePart(encodedIv ?? "", 12);
    const encrypted = decodeEnvelopePart(encodedCiphertext ?? "");
    const tag = decodeEnvelopePart(encodedTag ?? "", 16);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad(version, purpose, keyId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Encrypted value failed authentication");
    }
  }
}
