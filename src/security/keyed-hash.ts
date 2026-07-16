import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacKeyRingConfig = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export type VersionedHash = {
  hash: string;
  keyId: string;
};

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function parseHmacKeyRing(raw: string, activeKeyId: string): HmacKeyRingConfig {
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error("Active HMAC key id must contain only letters, numbers, underscores, or hyphens");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HMAC key ring must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("HMAC key ring must be a JSON object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) {
    throw new Error("HMAC key ring must contain between 1 and 8 keys");
  }
  const keys = new Map<string, Buffer>();
  const fingerprints = new Set<string>();
  for (const [keyId, encoded] of entries) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof encoded !== "string") {
      throw new Error("HMAC key ring contains an invalid key id or value");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) {
      throw new Error(`HMAC key ${keyId} must be canonical base64 containing exactly 32 bytes`);
    }
    if (fingerprints.has(encoded)) throw new Error("HMAC key values must be unique");
    fingerprints.add(encoded);
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) throw new Error("Active HMAC key id is not present in the key ring");
  return { activeKeyId, keys };
}

export function legacyHmacKeyRing(secret: string): HmacKeyRingConfig {
  const length = Buffer.byteLength(secret, "utf8");
  if (length < 32 || length > 1024) {
    throw new Error("Legacy HMAC secret must contain between 32 and 1024 bytes");
  }
  return { activeKeyId: "legacy", keys: new Map([["legacy", Buffer.from(secret, "utf8")]]) };
}

export class VersionedHmac {
  readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(config: HmacKeyRingConfig) {
    this.activeKeyId = config.activeKeyId;
    this.keys = new Map([...config.keys].map(([id, key]) => [id, Buffer.from(key)]));
  }

  hash(value: string, purpose: string, keyId = this.activeKeyId): VersionedHash {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`HMAC key is unavailable: ${keyId}`);
    const hmac = createHmac("sha256", key);
    if (keyId === "legacy") {
      // Compatibility for identifiers created before key ids existed. Keep this
      // key only until the longest message-record retention period has elapsed.
      hmac.update(purpose, "utf8").update("\u0000", "utf8").update(value, "utf8");
    } else {
      hmac
        .update("company-whatsapp-assistant\u0000", "utf8")
        .update(purpose, "utf8")
        .update("\u0000", "utf8")
        .update(value, "utf8");
    }
    return {
      keyId,
      hash: hmac.digest("hex")
    };
  }

  candidates(value: string, purpose: string): VersionedHash[] {
    const keyIds = [this.activeKeyId, ...[...this.keys.keys()].filter((keyId) => keyId !== this.activeKeyId)];
    return keyIds.map((keyId) => this.hash(value, purpose, keyId));
  }

  verify(value: string, purpose: string, expectedHex: string, keyId: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedHex)) return false;
    const actual = this.hash(value, purpose, keyId).hash;
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedHex, "hex"));
  }

  destroy(): void {
    for (const key of this.keys.values()) key.fill(0);
  }
}
