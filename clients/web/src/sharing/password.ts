import { argon2, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Passwords on share links (DESIGN.md §12, ROADMAP 1c.5): hashed with **Argon2id**, by Node's own implementation (no dependency to
 * choose, audit or keep up), and stored as a PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) that carries its own parameters,
 * so they can be raised later without invalidating what is stored. The parameters are OWASP's minimum for Argon2id (19 MiB, two
 * passes, one lane). Only the hash is kept; the password itself is never stored, logged or returned.
 */
export const ARGON2 = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32, saltLength: 16 } as const;

/** What a password may be: long enough to be worth hashing, and not a megabyte. */
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 200;

export function isAcceptablePassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_PASSWORD_CHARS && value.length <= MAX_PASSWORD_CHARS && value.isWellFormed() && !value.includes("\0");
}

type Params = { memory: number; passes: number; parallelism: number; tagLength: number };

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, parallelism: params.parallelism, tagLength: params.tagLength, memory: params.memory, passes: params.passes }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(ARGON2.saltLength);
  const key = await derive(password, salt, ARGON2);
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${b64(salt)}$${b64(key)}`;
}

/** The parameters, salt and hash of a stored string; undefined for anything that is not one this module wrote or would accept. */
function parse(stored: string): (Params & { salt: Buffer; key: Buffer }) | undefined {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!match) return undefined;
  const [memory, passes, parallelism] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A stored string is ours, but it is read back from a database: refuse parameters that would make a check cost a server.
  if (memory < 8 || memory > 262_144 || passes < 1 || passes > 10 || parallelism < 1 || parallelism > 8) return undefined;
  const salt = Buffer.from(match[4]!, "base64");
  const key = Buffer.from(match[5]!, "base64");
  if (salt.length < 8 || key.length < 16 || key.length > 64) return undefined;
  return { memory, passes, parallelism, tagLength: key.length, salt, key };
}

/** Whether the password is the one that was hashed. False, never an error, for a string that is not a hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || !isAcceptablePassword(password)) return false;
  const key = await derive(password, parsed.salt, parsed);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/**
 * The proof that a password was given for a link (ROADMAP 1c.5): a keyed hash of the link and its password hash. Whoever has a link's
 * token has it before the password, so a cookie of the token alone would be a way round the password; the cookie of a link with one
 * carries this too, and the page asks for it. It is made with a secret only the server has (`FJORD_AUTH_SECRET`), and it is
 * bound to the password hash, so changing the password ends every cookie given for the old one.
 */
export function unlockProof(secret: string, linkId: number, passwordHash: string): string {
  return createHmac("sha256", secret).update(`fjord-share-unlock\0${linkId}\0${passwordHash}`).digest("base64url");
}

export function proofIsRight(secret: string, linkId: number, passwordHash: string, proof: string | undefined): boolean {
  if (proof === undefined) return false;
  const expected = Buffer.from(unlockProof(secret, linkId, passwordHash));
  const given = Buffer.from(proof);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * How long to wait between tries at a link's password, from the failures so far (ROADMAP 1c.5): a second apart for the first few,
 * then 5 seconds doubling to a quarter of an hour. Every try waits, so tries cannot be made in parallel, and a wrong one makes the
 * next wait longer; a right one starts again.
 */
export function waitAfter(failures: number): number {
  if (failures < 3) return 1000;
  return Math.min(5000 * 2 ** (failures - 3), 15 * 60 * 1000);
}
