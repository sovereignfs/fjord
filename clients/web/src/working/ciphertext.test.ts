import { describe, expect, it } from "vitest";
import { MAX_CIPHERTEXT_BYTES, fromBase64, looksEncrypted, toBase64, whyNotCiphertext } from "./ciphertext";

const AGE = new TextEncoder().encode("age-encryption.org/v1\n-> X25519 abc\n");

describe("what an encrypted draft may be", () => {
  it("is base64 of something that begins as age does, binary or armored", () => {
    expect(whyNotCiphertext(toBase64(AGE))).toBeUndefined();
    expect(whyNotCiphertext(toBase64(new TextEncoder().encode("-----BEGIN AGE ENCRYPTED FILE-----\nAAA\n")))).toBeUndefined();
  });

  it("is never plain text, which is how plaintext would get into an encrypted vault", () => {
    expect(whyNotCiphertext(toBase64(new TextEncoder().encode("# My secret note\n")))).toMatch(/not age-encrypted/);
    expect(whyNotCiphertext("# My secret note\n")).toMatch(/not base64/);
    expect(whyNotCiphertext("")).toMatch(/not age-encrypted/);
  });

  it.each([["whitespace inside", "YWdl\nYWdl"], ["the URL alphabet", "YWdl-_8="], ["a missing pad", "YWdlYQ"], ["a stray character", "YWdl!"]])("is standard padded base64 only: %s is refused", (_name, text) => {
    expect(whyNotCiphertext(text)).toMatch(/not base64/);
  });

  it("is of a bounded size", () => {
    expect(whyNotCiphertext("A".repeat(Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 8))).toMatch(/larger/);
  });

  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 97, 103, 101]);
    expect([...(fromBase64(toBase64(bytes)) ?? [])]).toEqual([...bytes]);
    expect(looksEncrypted(AGE)).toBe(true);
    expect(looksEncrypted(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
