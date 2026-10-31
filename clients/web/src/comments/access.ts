import { type Action, type Grant, type Role, decide, effectiveRole } from "../access/policy";
import { type Limiter, takeAll } from "../limits/rate";
import { cleanGuestName } from "../sharing/guest-name";
import type { Watch } from "./events";
import { reanchorRates, writeRates } from "./rates";
import { type Author, type CommentService, type Done, type Thread, type TextQuoteAnchor } from "./service";

/**
 * Who may do what to a document's comments (DESIGN.md §12, §13, ROADMAP 1d.1). `http.ts` has the request's rules; this has the policy's:
 * each operation asks `decide` for its action, so a role means the same here as everywhere, and the answer is the policy's: `hidden` (not
 * let in at all, or no document to be let into) is told as "not found", `forbidden` (let in, but not to this) as such.
 *
 *  - **View** may read the threads. (Moving a thread onto the words its text was edited into, ROADMAP 1d.2, is for those who may comment.)
 *  - **Rate and share:** writing is counted against the person and the link (`rates.ts`) and refused with how long to wait; no one person takes more than
 *    their share of a document's threads, nor a link's guests more than theirs (the service, ROADMAP 1d.4). **Comment** may also start a thread, reply, resolve and open again, edit or delete its own.
 *    **Edit** may all of that. **The owner** may also delete anyone's and close a document's comments. (A share never moderates.)
 *  - **Whose a comment is** is the author's: an account by its id, a guest by the link and the id their browser made up, with the name
 *    they gave. A signed-in account is itself even when it came in by a link. A guest must give a name and a browser id to write.
 *  - Comments are on documents only: a note, or a document in an encrypted vault, is never a place for them.
 */
export interface Viewer {
  connectionId: number;
  grants: Grant[];
  /** The signed-in account, if there is one. */
  account?: { id: string; name: string };
  /** For someone who came in by a link: which, so that a guest's id is the link's. */
  linkId?: number;
}

export type Operation =
  | { op: "list" }
  | { op: "thread"; anchor: TextQuoteAnchor; body: string }
  | { op: "reply"; thread: number; body: string }
  | { op: "resolve"; thread: number; resolved: boolean }
  | { op: "edit"; target: { kind: "thread" | "reply"; id: number }; body: string }
  | { op: "delete"; target: { kind: "thread" | "reply"; id: number } }
  | { op: "reanchor"; thread: number; from: TextQuoteAnchor; to: TextQuoteAnchor }
  | { op: "close"; closed: boolean };

/** Who is asking, as the request says: the name and the browser's id of someone with no account. */
export interface Claimed {
  name?: unknown;
  clientId?: unknown;
}

export type Outcome =
  | { ok: true; id?: number; threads?: Thread[]; closed?: boolean; version?: number; viewer?: { role: "owner" | Role; canComment: boolean; canModerate: boolean; name: string | null } }
  | { ok: false; reason: "hidden" | "forbidden" | "need_name" | "closed" | "not_found" | "too_many" | "bad_comment" | "bad_anchor" | "stale" | "own_limit" | "rate_limited"; retryAfterMs?: number };

export interface AccessDeps {
  /** Who this is, for this document: their grants and where it is; undefined if they are let in nowhere. */
  viewer: (input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined }) => Promise<Viewer | undefined>;
  comments: Pick<CommentService, "list" | "createThread" | "reply" | "setResolved" | "edit" | "remove" | "setClosed" | "reanchor">;
  /** Counts how fast comments are written; without one there is no limit (ROADMAP 1d.4). */
  limiter?: Limiter;
  now?: () => number;
}

const DOCUMENT = { kind: "document" } as const;
/** A browser's id: made up by the browser, a few characters of a safe alphabet. */
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function commentsAccess(deps: AccessDeps) {
  return async function run(input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined; claimed: Claimed; operation: Operation }): Promise<Outcome> {
    const now = deps.now?.() ?? Date.now();
    const viewer = await deps.viewer({ docId: input.docId, account: input.account, cookie: input.cookie });
    if (!viewer) return { ok: false, reason: "hidden" };
    const { operation } = input;

    const action: Action =
      operation.op === "list" ? "read"
      : operation.op === "thread" || operation.op === "reanchor" ? "comment"
      : operation.op === "reply" ? "reply"
      : operation.op === "resolve" ? "resolve"
      : operation.op === "edit" ? "edit_own_comment"
      : operation.op === "delete" ? "delete_own_comment"
      : "moderate_comments";
    const decision = decide(viewer.grants, action, DOCUMENT, now);
    if (decision !== "allow") return { ok: false, reason: decision };

    const role = effectiveRole(viewer.grants, now)!;
    const owner = role === "owner";
    const asked = authorOf(viewer, input.claimed);
    // Reading needs no name. Writing as a guest does: it is the credit, and what tells their own comments apart.
    if (operation.op === "list") {
      const { threads, closed, version } = await deps.comments.list(viewer.connectionId, input.docId, asked.author);
      return {
        ok: true,
        threads,
        closed,
        version,
        viewer: {
          role,
          canComment: decide(viewer.grants, "comment", DOCUMENT, now) === "allow",
          canModerate: decide(viewer.grants, "moderate_comments", DOCUMENT, now) === "allow",
          name: asked.author?.name ?? null,
        },
      };
    }
    // Moving a thread onto the words its text was edited into is mechanical, not something a person wrote: it needs the right to comment but no name.
    if (operation.op === "reanchor") {
      const slow = await takeAll(deps.limiter, reanchorRates(viewer));
      if (!slow.ok) return { ok: false, reason: "rate_limited", retryAfterMs: slow.retryAfterMs };
      const done = await deps.comments.reanchor(viewer.connectionId, input.docId, operation.thread, operation.from, operation.to);
      return done.ok ? { ok: true } : { ok: false, reason: done.reason };
    }
    if (!asked.author) return { ok: false, reason: "need_name" };
    const { author } = asked;
    // What is written is counted against the person and the link, before anything is looked at: a flood of bad requests is a flood too.
    if (operation.op === "thread" || operation.op === "reply" || operation.op === "edit" || operation.op === "resolve") {
      const slow = await takeAll(deps.limiter, writeRates(viewer, author));
      if (!slow.ok) return { ok: false, reason: "rate_limited", retryAfterMs: slow.retryAfterMs };
    }

    const finish = (done: Done<{ id?: number }>): Outcome => (done.ok ? { ok: true, ...(done.id === undefined ? {} : { id: done.id }) } : { ok: false, reason: done.reason });
    switch (operation.op) {
      case "thread":
        return finish(await deps.comments.createThread(viewer.connectionId, input.docId, operation.anchor, operation.body, author));
      case "reply":
        return finish(await deps.comments.reply(viewer.connectionId, input.docId, operation.thread, operation.body, author));
      case "resolve":
        return finish(await deps.comments.setResolved(viewer.connectionId, input.docId, operation.thread, operation.resolved, author));
      case "edit":
        return finish(await deps.comments.edit(viewer.connectionId, input.docId, operation.target, operation.body, author));
      case "delete":
        // The author's own comment, or anyone's for the owner (the policy's `moderate_comments`).
        return finish(await deps.comments.remove(viewer.connectionId, input.docId, operation.target, author, owner && decide(viewer.grants, "moderate_comments", DOCUMENT, now) === "allow"));
      case "close":
        await deps.comments.setClosed(viewer.connectionId, input.docId, operation.closed, author);
        return { ok: true };
    }
  };
}

/** The author of what is written: the signed-in account, else a guest by the link and browser id and the name they gave. */
function authorOf(viewer: Viewer, claimed: Claimed): { author: Author | undefined } {
  if (viewer.account) return { author: { kind: "account", id: viewer.account.id, name: viewer.account.name } };
  const name = cleanGuestName(claimed.name);
  if (name === undefined || typeof claimed.clientId !== "string" || !CLIENT_ID.test(claimed.clientId) || viewer.linkId === undefined) return { author: undefined };
  return { author: { kind: "guest", id: `${viewer.linkId}:${claimed.clientId}`, name } };
}

/**
 * Who may watch a document's comments (ROADMAP 1d.3): who may read them. The answer is a `Watch` that asks the same thing again whenever it is
 * asked whether the watcher may still, so a link that has been revoked or has expired stops being listened for.
 */
export function commentsWatch(deps: AccessDeps & { comments: Pick<CommentService, "version">; subscribe: (connectionId: number, docId: string, listener: () => void) => () => void }) {
  return async function open(input: { docId: string; account: { id: string; name: string } | undefined; cookie: string | undefined }): Promise<{ ok: true; watch: Watch } | { ok: false; reason: "hidden" | "forbidden" }> {
    const allowed = async (): Promise<{ viewer: Viewer } | { reason: "hidden" | "forbidden" }> => {
      const viewer = await deps.viewer(input);
      if (!viewer) return { reason: "hidden" };
      const decision = decide(viewer.grants, "read", DOCUMENT, deps.now?.() ?? Date.now());
      return decision === "allow" ? { viewer } : { reason: decision };
    };
    const first = await allowed();
    if (!("viewer" in first)) return { ok: false, reason: first.reason };
    const { connectionId } = first.viewer;
    return {
      ok: true,
      watch: {
        holder: first.viewer.account ? `account:${first.viewer.account.id}` : `link:${first.viewer.linkId ?? 0}`,
        version: () => deps.comments.version(connectionId, input.docId),
        allowed: async () => "viewer" in (await allowed()),
        subscribe: (listener) => deps.subscribe(connectionId, input.docId, listener),
      },
    };
  };
}
