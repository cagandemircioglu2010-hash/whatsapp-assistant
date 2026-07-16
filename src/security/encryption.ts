import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const LEGACY_ENVELOPE_VERSION = "v1";
const ENVELOPE_VERSION = "v2";
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
  const fingerprints = new Set<string>();
  for (const [keyId, encodedKey] of entries) {
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error("An encryption key id is invalid");
    const key = decodeKey(encodedKey);
    const fingerprint = key.toString("base64");
    if (fingerprints.has(fingerprint)) throw new Error("Encryption key values must be unique");
    fingerprints.add(fingerprint);
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) throw new Error("The active encryption key id is missing from the key ring");
  return { activeKeyId, keys };
}

function aad(version: string, purpose: string, keyId: string, recordBinding?: string): Buffer {
  if (!/^[a-z][a-z0-9_.-]{2,63}$/.test(purpose)) throw new Error("Encryption purpose is invalid");
  if (version === ENVELOPE_VERSION && !recordBinding) throw new Error("Encryption record binding is required");
  return Buffer.from(
    version === LEGACY_ENVELOPE_VERSION
      ? `${version}\u0000${purpose}\u0000${keyId}`
      : `${version}\u0000${purpose}\u0000${keyId}\u0000${recordBinding}`,
    "utf8"
  );
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
  readonly activeKeyId: string;
  private readonly config: DataEncryptionConfig;

  constructor(config: DataEncryptionConfig) {
    this.activeKeyId = config.activeKeyId;
    this.config = {
      activeKeyId: config.activeKeyId,
      keys: new Map([...config.keys].map(([id, key]) => [id, Buffer.from(key)]))
    };
  }

  encrypt(plaintext: string, purpose: string, recordBinding: string): EncryptedValue {
    const keyId = this.config.activeKeyId;
    const key = this.config.keys.get(keyId);
    if (!key) throw new Error("Active encryption key is unavailable");

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(ENVELOPE_VERSION, purpose, keyId, recordBinding));
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

  decrypt(envelope: string, purpose: string, recordBinding: string): string {
    if (Buffer.byteLength(envelope, "utf8") > MAX_ENVELOPE_BYTES) {
      throw new Error("Encrypted value is too large");
    }
    const parts = envelope.split(".");
    if (parts.length !== 5) throw new Error("Encrypted value is malformed");
    const [version, keyId, encodedIv, encodedCiphertext, encodedTag] = parts;
    if (
      (version !== ENVELOPE_VERSION && version !== LEGACY_ENVELOPE_VERSION) ||
      !keyId ||
      !KEY_ID_PATTERN.test(keyId)
    ) {
      throw new Error("Encrypted value is malformed");
    }
    const key = this.config.keys.get(keyId);
    if (!key) throw new Error(`Encryption key '${keyId}' is unavailable`);

    const iv = decodeEnvelopePart(encodedIv ?? "", 12);
    const encrypted = decodeEnvelopePart(encodedCiphertext ?? "");
    const tag = decodeEnvelopePart(encodedTag ?? "", 16);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad(version, purpose, keyId, recordBinding));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Encrypted value failed authentication");
    }
  }

  isCurrentEnvelope(envelope: string, keyId = this.config.activeKeyId): boolean {
    return envelope.startsWith(`${ENVELOPE_VERSION}.${keyId}.`);
  }

  destroy(): void {
    for (const key of this.config.keys.values()) key.fill(0);
  }
}
