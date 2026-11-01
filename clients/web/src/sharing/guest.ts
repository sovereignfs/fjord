import { decide } from "../access/policy";
import { bodyStartOf } from "../browse/document";
import type { DocIndex } from "../browse/doc-index";
import { type Source, resolveDocId } from "../browse/ids";
import { readTextBlob } from "../browse/note";
import type { Fjord } from "../format/wasm";
import { type Limiter, type Rule, takeAll } from "../limits/rate";
import type { WorkingCopyService } from "../working/service";
import type { LinkService } from "./links";
import { proofIsRight } from "./password";
import { MAX_NAME_CHARS, cleanGuestName } from "./guest-name";
import { parseShareCookie } from "./unlock";

/**
 * Editing a document through a link (DESIGN.md §11, §12, ROADMAP 1c.6). Someone with an edit link, and no account, changes the
 * document's **working copy**, the same draft the owner sees and saves a version of (1b.8, 1b.9), and is credited in that version by the
 * display name they gave.
 *
 *  - **The link decides, not the person.** The cookie must hold a token of a link of *this* document that is live, whose role may edit
 *    (the policy's `edit`), and, for a link with a password, the proof that it was given. Anything else is "hidden": not told apart
 *    from there being no such document. A comment or view link is "forbidden", which it may be told.
 *  - **Only the body is theirs.** The client sends the body of the document, as the editor holds it; the header, with the `id`, the title
 *    and whatever else it has, is the draft's or the file's as it is, put back in front, so a guest cannot change what the document is.
 *    A document whose header cannot be read is not edited through a link at all.
 *  - **A name is required, and it is the credit.** One line, up to 40 characters, with no control characters or angle brackets, kept as
 *    given: a guest can give any name, which is what "the display name they gave" means, and the commit's address (`link-<n>-<hash>@…
 *    .invalid`) says it was a link and not an account.
 *  - **Nothing is overwritten that was not theirs to change.** The draft keeps the base it was started from, whoever saves it; two
 *    people typing at once is last-write-wins until real-time editing (phase 3), and both stay in the list of who edited.
 */
export interface GuestDeps {
  links: Pick<LinkService, "byToken">;
  /** The server's secret: a link with a password opens only with the proof that it was given. */
  secret: string;
  sourceOf: (connectionId: number) => Promise<Source | undefined>;
  index: DocIndex;
  format: Pick<Fjord, "parseDocument">;
  drafts: Pick<WorkingCopyService, "get" | "save">;
  /** Counts how fast a link is used to edit; without one there is no limit (ROADMAP 1d.4). */
  limiter?: Limiter;
  now?: () => number;
}

/**
 * How fast a link may be used to edit (ROADMAP 1d.4): all of its editors together, because a name is anything a guest says it is. A person typing keeps
 * a draft a second or so behind them, so several at once fit well inside this; what does not is something sending text as fast as it can.
 */
export const GUEST_EDIT_RATES: Rule[] = [{ limit: 240, windowMs: 60_000 }, { limit: 3000, windowMs: 3_600_000 }];

export { MAX_NAME_CHARS, cleanGuestName };

export type GuestSave =
  | { ok: true; savedAt: number }
  /** Not a link that lets this in, or not a document that is there: not told apart. */
  | { ok: false; reason: "hidden" }
  /** A link that is good, but whose role may not edit. */
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "bad_name" }
  /** Edits through this link are coming faster than anyone types; when to try again, in milliseconds. */
  | { ok: false; reason: "rate_limited"; retryAfterMs: number }
  | { ok: false; reason: "not_editable" | "too_many_drafts" | "too_many_editors" | "unavailable" }
  | { ok: false; reason: "unstorable"; message: string };

export async function saveGuestDraft(deps: GuestDeps, input: { cookie: string | undefined; docId: string; name: unknown; body: string }): Promise<GuestSave> {
  const now = deps.now?.() ?? Date.now();
  if (input.cookie === undefined) return { ok: false, reason: "hidden" };
  const { token, proof } = parseShareCookie(input.cookie);
  const link = await deps.links.byToken(token);
  if (!link || link.docId !== input.docId) return { ok: false, reason: "hidden" };
  const grant = { kind: "link", role: link.role, expiresAt: link.expiresAt, revoked: link.revokedAt !== null } as const;
  const decision = decide([grant], "edit", { kind: "document" }, now);
  if (decision === "hidden") return { ok: false, reason: "hidden" };
  if (link.passwordHash !== null && !proofIsRight(deps.secret, link.id, link.passwordHash, proof)) return { ok: false, reason: "hidden" };
  if (decision === "forbidden") return { ok: false, reason: "forbidden" };

  const name = cleanGuestName(input.name);
  if (name === undefined) return { ok: false, reason: "bad_name" };

  const slow = await takeAll(deps.limiter, GUEST_EDIT_RATES.map((rule) => ({ key: `guest-edit:link:${link.id}:${rule.windowMs}`, rule })));
  if (!slow.ok) return { ok: false, reason: "rate_limited", retryAfterMs: slow.retryAfterMs };

  const source = await deps.sourceOf(link.connectionId);
  if (!source) return { ok: false, reason: "unavailable" };
  const { matches } = await resolveDocId({ index: deps.index, format: deps.format }, [source], input.docId);
  const match = matches.find((candidate) => candidate.kind === "document");
  const blob = match ? source.read.blobs.get(match.path) : undefined;
  if (!match || blob === undefined) return { ok: false, reason: "hidden" };

  // What the body is put after: the working copy as it is, else the file.
  const existing = await deps.drafts.get(link.connectionId, match.path);
  let before: string;
  let baseBlob: string;
  if (existing) {
    // A draft of an encrypted file is ciphertext, which a guest's text cannot be put after (a shared document is never in an encrypted vault).
    if (existing.encrypted) return { ok: false, reason: "not_editable" };
    before = existing.content;
    baseBlob = existing.baseBlob;
  } else {
    const text = await readTextBlob(source.provider, source.ref, blob);
    if (!text.ok) return { ok: false, reason: "not_editable" };
    before = text.text;
    baseBlob = blob;
  }
  const start = bodyStartOf(deps.format, before);
  if (start === undefined) return { ok: false, reason: "not_editable" };
  const content = before.slice(0, start) + input.body;
  // Nothing changed, and there is no draft to keep: the guest has only put back what the file says.
  if (!existing && content === before) return { ok: true, savedAt: now };

  const saved = await deps.drafts.save(link.connectionId, match.path, { baseBlob, content }, { type: "guest", link: link.id, name });
  if (saved.ok) return { ok: true, savedAt: saved.workingCopy.lastEdit };
  switch (saved.reason) {
    case "unstorable":
      return { ok: false, reason: "unstorable", message: saved.message };
    case "too_many":
      return { ok: false, reason: "too_many_drafts" };
    case "too_many_editors":
      return { ok: false, reason: "too_many_editors" };
    case "base_mismatch":
    case "encryption_mismatch":
      return { ok: false, reason: "unavailable" };
  }
}
