import { isAcceptablePassword, unlockProof, verifyPassword } from "../sharing/password";
import { TOKEN_PATTERN } from "../sharing/tokens";
import type { PublicationService } from "./publications";

/**
 * Giving the password of a published page (DESIGN.md §12), as for a link's (`sharing/unlock.ts`): the same slow, one-at-a-time tries (a try is first *claimed*, and each claim
 * makes the next wait), the password Argon2id-hashed and never kept, and, when it is right, a proof made with a secret only the server has and bound to the password's hash, so that
 * changing the password ends every cookie given for the old one. The page's address names the page, so the cookie holds the proof alone, and only for that address.
 */
export interface UnlockPublicationDeps {
  publications: Pick<PublicationService, "find" | "claimTry" | "recordFailure" | "recordSuccess">;
  secret: string;
  /** For tests. */
  verify?: (password: string, hash: string) => Promise<boolean>;
}

export type UnlockPublicationResult =
  | { ok: true; proof: string }
  | { ok: false; reason: "wrong" }
  | { ok: false; reason: "wait"; retryAt: number }
  /** No such page, or one with no password. Not told apart. */
  | { ok: false; reason: "gone" };

/** The cookie that holds the proof, for the page's address alone (`Path=/p/<token>`). */
export const PUBLICATION_COOKIE = "fjord_pub";

/** How long what the right password gives lasts, in seconds. */
export const PUBLICATION_COOKIE_SECONDS = 12 * 60 * 60;

export async function tryUnlockPublication(deps: UnlockPublicationDeps, input: { token: string; password: unknown }): Promise<UnlockPublicationResult> {
  if (!TOKEN_PATTERN.test(input.token)) return { ok: false, reason: "gone" };
  const found = await deps.publications.find(input.token);
  if (!found || found.passwordHash === null) return { ok: false, reason: "gone" };
  const claim = await deps.publications.claimTry(found.id);
  if (!claim.claimed) return { ok: false, reason: "wait", retryAt: claim.retryAt };
  const right = isAcceptablePassword(input.password) && (await (deps.verify ?? verifyPassword)(input.password, found.passwordHash));
  if (!right) {
    await deps.publications.recordFailure(found.id);
    return { ok: false, reason: "wrong" };
  }
  await deps.publications.recordSuccess(found.id);
  return { ok: true, proof: unlockProof(deps.secret, found.id, found.passwordHash, "fjord-publication-unlock") };
}
