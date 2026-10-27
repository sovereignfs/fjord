import { createHash, randomBytes } from "node:crypto";

/**
 * The secret in a share link (DESIGN.md §12, ROADMAP 1c.3): 32 random bytes, written as 43 URL-safe characters. A Doc id is not
 * a secret (it is in the repository), so the link carries its own. Only the SHA-256 of it is ever stored. A plain hash is
 * enough for something that is already 256 bits of randomness: there is nothing to guess, so nothing for a slow hash to slow down.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(random: (size: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
