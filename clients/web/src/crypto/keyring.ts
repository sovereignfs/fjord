import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../db/config";

/**
 * The instance's keys for wrapping credentials' own keys (DESIGN.md §7): one current key, which
 * wraps, and any number of previous ones, which can still unwrap what was wrapped under them
 * until a restart has re-wrapped it under the current one (rotation). A key is 32 random bytes;
 * it is known by a fingerprint, so nothing needs configuring but the key itself, and so a stored
 * credential says which key it needs without saying anything about the key.
 */
export interface Kek {
  /** A fingerprint of the key: 16 hex characters of a domain-separated SHA-256. Not secret. */
  id: string;
  key: Buffer;
}

export class Keyring {
  readonly current: Kek;
  private readonly all: Map<string, Kek>;

  constructor(current: Buffer, previous: Buffer[] = []) {
    this.current = toKek(current);
    this.all = new Map([[this.current.id, this.current]]);
    for (const key of previous) {
      const kek = toKek(key);
      if (this.all.has(kek.id)) throw new ConfigError("The same encryption key is configured twice.");
      this.all.set(kek.id, kek);
    }
  }

  find(id: string): Kek | undefined {
    return this.all.get(id);
  }

  /** The fingerprints of the previous keys. */
  get previousIds(): string[] {
    return [...this.all.keys()].filter((id) => id !== this.current.id);
  }
}

export const KEY_BYTES = 32;

function toKek(key: Buffer): Kek {
  if (key.length !== KEY_BYTES) throw new ConfigError(`An encryption key must be ${KEY_BYTES} bytes.`);
  const id = createHash("sha256").update("fjord-kek-id-v1").update(key).digest("hex").slice(0, 16);
  return { id, key };
}

/** A key as an operator writes it: 64 hex characters, or base64 (`openssl rand -base64 32`). */
export function parseKey(text: string): Buffer | undefined {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return bytes.length === KEY_BYTES ? bytes : undefined;
}

/** Whether two keys are the same, without a timing difference to learn from. */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
