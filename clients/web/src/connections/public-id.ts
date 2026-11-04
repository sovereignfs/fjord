/**
 * What a connected repository is called in an address: `/repo/k3x9m2qa`. Eight lower-case characters of Crockford's base32 (40 random bits), so that
 * an address shows neither how many repositories an instance holds nor in what order they were connected, and cannot be told from a handle (`src/browse/handles.ts`)
 * by anything but its length. It is a name and not a secret: reaching a repository still takes the account that connected it.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const PUBLIC_ID_LENGTH = 8;

/** Whether a string can be a repository's public id, before anything is looked up. */
export function isPublicId(value: string): boolean {
  return value.length === PUBLIC_ID_LENGTH && [...value].every((character) => ALPHABET.includes(character));
}

/** A new public id from random bytes (at least `PUBLIC_ID_LENGTH` of them; the default source is the platform's). */
export function newPublicId(random: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(PUBLIC_ID_LENGTH))): string {
  let out = "";
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) out += ALPHABET[(random[i] as number) & 31];
  return out;
}

/** Whether a URL segment is the number a repository was addressed by before public ids (`/repo/3`), which still leads to it. */
export function isLegacyId(value: string): boolean {
  // Shorter than a public id, so that no public id (which may be all digits) is taken for one.
  return /^[0-9]{1,7}$/.test(value);
}
