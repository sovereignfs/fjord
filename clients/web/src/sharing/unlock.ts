import { decide } from "../access/policy";
import { isDocId } from "../browse/ids";
import type { LinkService } from "./links";
import { COOKIE_MAX_AGE_SECONDS } from "./enter";
import { isAcceptablePassword, unlockProof, verifyPassword } from "./password";
import { TOKEN_PATTERN } from "./tokens";

/**
 * Giving the password of a link (DESIGN.md §12, ROADMAP 1c.5). A link with a password lets nobody in with its token: entering it
 * (`enter.ts`) leaves the token waiting in a pending cookie, and the page asks for the password, which comes here.
 *
 *  - **Tries are slow and one at a time.** A try is first *claimed* (`LinkService.claimTry`), in one statement that only one of several at
 *    once can win, and each claim makes the next wait (`waitAfter` the failures so far): a second apart at first, then five seconds
 *    doubling to a quarter of an hour. A wrong password makes the next wait longer; the right one starts again. A try that cannot be
 *    claimed is not checked at all, so a right password given too soon is refused too, and a wrong guess costs the same either way.
 *  - **The password is Argon2id-hashed on the server and never kept**; a password that is not an acceptable one (too short, too long) is
 *    wrong without being hashed, and counts.
 *  - **What it gives is the cookie that opens the link**: the token and a proof, made with a secret only the server has and bound
 *    to the password's hash (`password.ts`), so the token alone, which anyone with the link has, never is enough.
 */
export interface UnlockDeps {
  links: Pick<LinkService, "byToken" | "claimTry" | "recordFailure" | "recordSuccess">;
  /** The server's secret, which the proof is keyed with. */
  secret: string;
  /** For tests. */
  verify?: (password: string, hash: string) => Promise<boolean>;
  now?: () => number;
}

export type UnlockResult =
  /** The right password: the cookie's value, and for how long. */
  | { ok: true; value: string; maxAgeSeconds: number }
  /** A wrong password. */
  | { ok: false; reason: "wrong" }
  /** Too soon after the last try: when the next may be made, in epoch milliseconds. */
  | { ok: false; reason: "wait"; retryAt: number }
  /** Nothing to unlock: no such link, for another document, not live, or one with no password. Not told apart. */
  | { ok: false; reason: "gone" };

export async function tryUnlock(deps: UnlockDeps, input: { docId: string; password: unknown; pendingToken: string | undefined }): Promise<UnlockResult> {
  const now = deps.now?.() ?? Date.now();
  if (!isDocId(input.docId) || input.pendingToken === undefined || !TOKEN_PATTERN.test(input.pendingToken)) return { ok: false, reason: "gone" };
  const link = await deps.links.byToken(input.pendingToken);
  if (!link || link.docId !== input.docId || link.passwordHash === null) return { ok: false, reason: "gone" };
  const grant = { kind: "link", role: link.role, expiresAt: link.expiresAt, revoked: link.revokedAt !== null } as const;
  if (decide([grant], "read", { kind: "document" }, now) !== "allow") return { ok: false, reason: "gone" };

  const claim = await deps.links.claimTry(link.id);
  if (!claim.claimed) return { ok: false, reason: "wait", retryAt: claim.retryAt };

  const right = isAcceptablePassword(input.password) && (await (deps.verify ?? verifyPassword)(input.password, link.passwordHash));
  if (!right) {
    await deps.links.recordFailure(link.id);
    return { ok: false, reason: "wrong" };
  }
  await deps.links.recordSuccess(link.id);
  const remaining = link.expiresAt === null ? COOKIE_MAX_AGE_SECONDS : Math.floor((link.expiresAt - now) / 1000);
  const maxAgeSeconds = Math.min(COOKIE_MAX_AGE_SECONDS, remaining);
  if (maxAgeSeconds <= 0) return { ok: false, reason: "gone" };
  return { ok: true, value: `${input.pendingToken}.${unlockProof(deps.secret, link.id, link.passwordHash)}`, maxAgeSeconds };
}

/** The token and, for a link with a password, the proof, out of a share cookie's value. */
export function parseShareCookie(value: string): { token: string; proof: string | undefined } {
  const dot = value.indexOf(".");
  return dot === -1 ? { token: value, proof: undefined } : { token: value.slice(0, dot), proof: value.slice(dot + 1) };
}
