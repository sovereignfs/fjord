/**
 * The draft of a file in an encrypted vault is its **ciphertext**, made in the browser and kept as base64 text (ROADMAP 2b.3, DESIGN.md §11). The server has no
 * key, so it can neither read nor make one; what it can do is refuse what is plainly not age, so that a page that forgot to encrypt can never put plaintext
 * into a vault that must hold none (spec §6, invariant 1). That is a check on the header, not on who it was encrypted to, which only a key could tell.
 */

/** What a binary age file starts with, and what an armored one does (spec §6.2 allows either as a payload). */
const BINARY = new TextEncoder().encode("age-encryption.org/v1\n");
const ARMORED = new TextEncoder().encode("-----BEGIN AGE ENCRYPTED FILE-----");

/** Standard base64 with padding, nothing else: no whitespace, no URL alphabet. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The most a ciphertext may be: a note's limit and room for age's header per recipient and the container of an `id`-named vault. */
export const MAX_CIPHERTEXT_BYTES = 1024 * 1024 + 64 * 1024;

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The bytes of a draft's content, or undefined if it is not base64. */
export function fromBase64(content: string): Uint8Array | undefined {
  if (!BASE64.test(content)) return undefined;
  return new Uint8Array(Buffer.from(content, "base64"));
}

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

/** Whether the bytes begin as an age file does. */
export const looksEncrypted = (bytes: Uint8Array): boolean => startsWith(bytes, BINARY) || startsWith(bytes, ARMORED);

/** Why `content` cannot be kept as the draft of an encrypted file, or `undefined` if it can. */
export function whyNotCiphertext(content: string): string | undefined {
  if (content.length > Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4) return "It is larger than an encrypted note can be.";
  const bytes = fromBase64(content);
  if (bytes === undefined) return "It is not base64 text, which is what an encrypted draft is kept as.";
  if (!looksEncrypted(bytes)) return "It is not age-encrypted, and a plain draft is never kept for an encrypted vault.";
  return undefined;
}
