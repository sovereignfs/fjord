import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CredentialError } from "./errors";
import type { Keyring } from "./keyring";

/**
 * Envelope encryption of one credential (DESIGN.md §7). The credential is encrypted with a key of
 * its own, a random 256-bit data key, in AES-256-GCM; that data key is encrypted ("wrapped") with
 * the instance's current key, also in AES-256-GCM. Rotating the instance key then means
 * unwrapping and wrapping 32 bytes per credential and never touching the credentials themselves,
 * and a data key that leaks exposes one credential.
 *
 * Both layers are bound to where they belong: the credential's id and its purpose go into the
 * authenticated data, and the wrapped key's also names the instance key. A stored value copied
 * onto another row, or given another purpose, does not open: it is reported as corrupt, not
 * decrypted for someone else. Each encryption uses a fresh random 96-bit nonce.
 *
 * Nothing here logs or throws a secret, a key or plaintext.
 */
export interface Sealed {
  /** The instance key the data key is wrapped under. */
  kekId: string;
  wrappedKey: string;
  ciphertext: string;
}

/** What a sealed credential is bound to. */
export interface Binding {
  id: string;
  purpose: string;
}

const VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const payloadAad = (b: Binding) => Buffer.from(JSON.stringify(["fjord-credential-v1", b.id, b.purpose]));
const wrapAad = (b: Binding, kekId: string) => Buffer.from(JSON.stringify(["fjord-credential-key-v1", b.id, b.purpose, kekId]));

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${Buffer.concat([nonce, body]).toString("base64url")}`;
}

function decrypt(key: Buffer, sealed: string, aad: Buffer): Buffer {
  const [version, encoded, ...rest] = sealed.split(".");
  const raw = encoded === undefined ? undefined : Buffer.from(encoded, "base64url");
  if (version !== VERSION || rest.length > 0 || !raw || raw.length < NONCE_BYTES + TAG_BYTES) throw corrupt();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw corrupt();
  }
}

const corrupt = () => new CredentialError("corrupt", "A stored credential cannot be decrypted: it has been altered or moved, or it is not from this instance.");

function unwrap(keyring: Keyring, binding: Binding, sealed: Pick<Sealed, "kekId" | "wrappedKey">): Buffer {
  const kek = keyring.find(sealed.kekId);
  if (!kek) {
    throw new CredentialError("unknown_key", `A stored credential was sealed under encryption key ${sealed.kekId}, which is not configured (FJORD_ENCRYPTION_KEY, FJORD_ENCRYPTION_KEY_PREVIOUS).`);
  }
  return decrypt(kek.key, sealed.wrappedKey, wrapAad(binding, kek.id));
}

export function seal(keyring: Keyring, binding: Binding, secret: string): Sealed {
  const dek = randomBytes(32);
  try {
    return {
      kekId: keyring.current.id,
      wrappedKey: encrypt(keyring.current.key, dek, wrapAad(binding, keyring.current.id)),
      ciphertext: encrypt(dek, Buffer.from(secret, "utf8"), payloadAad(binding)),
    };
  } finally {
    dek.fill(0);
  }
}

export function open(keyring: Keyring, binding: Binding, sealed: Sealed): string {
  const dek = unwrap(keyring, binding, sealed);
  try {
    const plaintext = decrypt(dek, sealed.ciphertext, payloadAad(binding));
    try {
      return plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
  } finally {
    dek.fill(0);
  }
}

/** Wrap the data key under the current instance key. The credential itself is untouched. */
export function rewrap(keyring: Keyring, binding: Binding, sealed: Pick<Sealed, "kekId" | "wrappedKey">): Pick<Sealed, "kekId" | "wrappedKey"> {
  const dek = unwrap(keyring, binding, sealed);
  try {
    return { kekId: keyring.current.id, wrappedKey: encrypt(keyring.current.key, dek, wrapAad(binding, keyring.current.id)) };
  } finally {
    dek.fill(0);
  }
}
