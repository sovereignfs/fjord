import { createHmac } from "node:crypto";

/**
 * What an authenticator app does, for tests: read the secret out of the `otpauth://` URI a
 * sign-in server shows as a QR code, and compute the six-digit code for a moment in time.
 * Kept apart from the database test support so the browser tests can use it too.
 */

/** The secret in an otpauth:// URI, as a base32 string. */
export function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret");
  if (!secret) throw new Error("no secret in the otpauth URI");
  return secret;
}

/** RFC 6238 time-based one-time password (SHA-1, 6 digits, 30 s): what an authenticator app shows. */
export function totp(base32Secret: string, atMs: number = Date.now(), stepSeconds = 30): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error("not base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / stepSeconds)));
  const hmac = createHmac("sha1", bytes).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}
