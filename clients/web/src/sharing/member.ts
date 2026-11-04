import { decide } from "../access/policy";
import { type Limiter, takeAll } from "../limits/rate";
import { GUEST_EDIT_RATES, type GuestSave, type DraftWriteDeps, writeDraftBody } from "./guest";
import type { ShareService } from "./shares";

/**
 * Editing a document that was shared with an account (the owner's request: sharing is within this instance). The same thing as editing through a link (`guest.ts`), with the account as the
 * credential instead of a cookie: someone who holds the **edit** role changes the document's **working copy**, the draft the owner sees, reviews and saves a version of; **nothing of theirs
 * reaches the repository**, which is the owner's. They are credited in that version as an account (the editor is the account's id), by the name it has.
 *
 *  - **The share decides.** The account must hold a share on this document whose role may edit (the policy's `edit`); any other account, a share that may only read or comment, and a document
 *    that is not there are the same "hidden" to an account with no share and "forbidden" to one that may only read, which it may be told.
 *  - **Only the body is theirs**, and it is rate-limited, as for a link, per account and document.
 */
export interface MemberDeps extends DraftWriteDeps {
  shares: Pick<ShareService, "find">;
  limiter?: Limiter;
  now?: () => number;
}

export async function saveMemberDraft(deps: MemberDeps, input: { accountId: string; docId: string; body: string }): Promise<GuestSave> {
  const now = deps.now?.() ?? Date.now();
  const shares = await deps.shares.find(input.accountId, input.docId);
  if (shares.length === 0) return { ok: false, reason: "hidden" };
  // The first share (by connection) that may edit; if there is one that may read and none that may edit, the person is told so.
  const mayEdit = shares.find((share) => decide([{ kind: "user", role: share.role }], "edit", { kind: "document" }, now) === "allow");
  if (!mayEdit) return { ok: false, reason: "forbidden" };

  const slow = await takeAll(deps.limiter, GUEST_EDIT_RATES.map((rule) => ({ key: `member-edit:${input.accountId}:${input.docId}:${rule.windowMs}`, rule })));
  if (!slow.ok) return { ok: false, reason: "rate_limited", retryAfterMs: slow.retryAfterMs };

  return writeDraftBody(deps, { connectionId: mayEdit.connectionId, docId: input.docId, body: input.body, editor: { type: "account", id: input.accountId }, now });
}
