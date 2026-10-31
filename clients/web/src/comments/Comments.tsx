"use client";

import type { Anchor, AnchorReport, CommentsAdapter, ThreadMark } from "fjord-editor";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";
import { cleanGuestName, MAX_NAME_CHARS } from "../sharing/guest-name";
import {
  type Claim,
  type Listing,
  type ReplyView,
  type ThreadView,
  addReply,
  clientId,
  deleteComment,
  eventsAddress,
  editComment,
  givenName,
  keepName,
  loadComments,
  moveThread,
  setClosed,
  setResolved,
  startThread,
  versionFrom,
} from "./client";
import { MAX_COMMENT_CHARS } from "./limits";

/**
 * A document's comments in the browser (DESIGN.md §13, ROADMAP 1d.1): the adapter the document editor marks its text from, the panel of
 * threads beside it, and the asking of a name from someone with no account. `useComments` gives all three for one document and one way in;
 * the page puts the panel next to the editor.
 *
 * Who is asking is the server's to know: a signed-in account is itself, and only someone who came in by a link (`guest`) is asked for a
 * name, kept in their browser, and sends it with the id their browser made up. What they may do is the server's too (`viewer` in the listing):
 * the panel offers what it is told they may.
 */
/** How long the text of a thread must have stayed found in its new place before the server is told (a person typing inside it changes it at every key). */
const MOVE_AFTER_MS = 1500;

export function useComments(docId: string | undefined, options: { guest: boolean }): { adapter: CommentsAdapter | undefined; onNeedName: () => Promise<boolean>; panel: ReactNode } {
  const { guest } = options;
  const [listing, setListing] = useState<Listing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [composing, setComposing] = useState<Anchor | null>(null);
  const [asking, setAsking] = useState(false);
  const answer = useRef<((named: boolean) => void) | null>(null);
  const listeners = useRef(new Set<() => void>());
  const threadsRef = useRef<ThreadView[]>([]);
  const activeRef = useRef<number | null>(null);
  /** What became of each thread in the text, as the editor last said (ROADMAP 1d.2); a thread it did not look for is not here. */
  const [fates, setFates] = useState<ReadonlyMap<number, "intact" | "edited" | "outdated">>(new Map());
  const listingRef = useRef<Listing | null>(null);
  const moving = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; wanted: AnchorReport["reanchored"]; tried: Set<string> }>({ timer: undefined, wanted: [], tried: new Set() });

  const claim = useCallback((): Claim => {
    if (!guest) return {};
    const name = givenName();
    return name ? { name, clientId: clientId() } : {};
  }, [guest]);

  const notify = useCallback(() => {
    for (const listener of [...listeners.current]) listener();
  }, []);

  const reload = useCallback(async () => {
    if (!docId) return;
    const done = await loadComments(docId, guest ? claim() : {});
    if (!done.ok) return setProblem(done.message);
    setProblem(null);
    setListing(done.listing);
    listingRef.current = done.listing;
    threadsRef.current = done.listing.threads;
    notify();
  }, [docId, guest, claim, notify]);

  // Live updates (ROADMAP 1d.3): the server says when the comments have moved on from the version this page read, and they are read again. The stream
  // carries no comment; a browser without it, or a stream that cannot be opened, leaves the page as it was, reading on its own visits.
  useEffect(() => {
    if (!docId || typeof EventSource === "undefined") return;
    const source = new EventSource(eventsAddress(docId));
    const moved = (event: MessageEvent) => {
      const version = versionFrom(event.data);
      if (version === undefined || version !== listingRef.current?.version) void reload();
    };
    source.addEventListener("version", moved);
    source.addEventListener("changed", moved);
    source.addEventListener("gone", () => {
      source.close();
      void reload();
    });
    return () => source.close();
  }, [docId, reload]);

  useEffect(() => {
    void reload();
    const again = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [reload]);

  const adapter = useMemo<CommentsAdapter | undefined>(() => {
    if (!docId) return undefined;
    return {
      threads: (): readonly ThreadMark[] => threadsRef.current.map((thread) => ({ id: String(thread.id), anchor: thread.anchor, resolved: thread.resolved, outdated: false })),
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      create: (anchor) => setComposing(anchor),
      open: (threadId) => {
        const id = Number(threadId);
        activeRef.current = id;
        setActive(id);
        notify();
        document.getElementById(`comment-thread-${id}`)?.scrollIntoView?.({ block: "nearest" });
      },
      active: () => (activeRef.current === null ? null : String(activeRef.current)),
      anchored: (report) => {
        const next = new Map<number, "intact" | "edited" | "outdated">();
        for (const [id, fate] of report.fates) next.set(Number(id), fate);
        setFates((before) => (before.size === next.size && [...next].every(([id, fate]) => before.get(id) === fate) ? before : next));
        keepMoving(report.reanchored);
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keepMoving` reads refs only
  }, [docId, notify]);

  /**
   * A thread whose text was edited has been found again, and the anchor that is true now is the editor's to hand over. Once it has stayed so for a
   * moment and the person may comment, the server is asked to keep it (from the anchor it has), so that the next change is compared with the words
   * as they are now. Once a move has been tried it is not tried again (a refusal means someone else moved it, or it is not for this person).
   */
  function keepMoving(wanted: AnchorReport["reanchored"]) {
    const state = moving.current;
    state.wanted = wanted;
    if (state.timer) clearTimeout(state.timer);
    if (wanted.length === 0 || !docId) return;
    state.timer = setTimeout(async () => {
      state.timer = undefined;
      if (!listingRef.current?.viewer.canComment) return;
      for (const move of state.wanted) {
        const key = `${move.id}:${JSON.stringify(move.to)}`;
        if (state.tried.has(key)) continue;
        state.tried.add(key);
        const done = await moveThread(docId, Number(move.id), move.from, move.to, claim());
        if (done.ok) {
          // Hold the thread where it is now, without a round trip: the editor finds it intact, and says nothing more of it.
          threadsRef.current = threadsRef.current.map((thread) => (thread.id === Number(move.id) ? { ...thread, anchor: move.to } : thread));
          notify();
        }
      }
    }, MOVE_AFTER_MS);
  }

  useEffect(() => () => clearTimeout(moving.current.timer), []);

  /** For a guest, before they write: the name they gave, or ask for it. Resolves whether there is one. */
  const onNeedName = useCallback(async (): Promise<boolean> => {
    if (!guest || givenName()) return true;
    setAsking(true);
    return new Promise<boolean>((resolve) => {
      answer.current = resolve;
    });
  }, [guest]);

  function chooseName(value: string | null) {
    const name = value === null ? undefined : cleanGuestName(value);
    if (name) keepName(name);
    setAsking(false);
    answer.current?.(name !== undefined);
    answer.current = null;
  }

  const panel = docId ? (
    <CommentsPanel
      docId={docId}
      listing={listing}
      problem={problem}
      active={active}
      fates={fates}
      composing={composing}
      asking={asking}
      claim={claim}
      needName={onNeedName}
      chooseName={chooseName}
      stopComposing={() => setComposing(null)}
      choose={(id) => {
        activeRef.current = id;
        setActive(id);
        notify();
      }}
      changed={reload}
    />
  ) : null;
  return { adapter, onNeedName, panel };
}

interface PanelProps {
  docId: string;
  listing: Listing | null;
  problem: string | null;
  active: number | null;
  fates: ReadonlyMap<number, "intact" | "edited" | "outdated">;
  composing: Anchor | null;
  asking: boolean;
  claim: () => Claim;
  needName: () => Promise<boolean>;
  chooseName: (name: string | null) => void;
  stopComposing: () => void;
  choose: (id: number | null) => void;
  changed: () => Promise<void>;
}

function CommentsPanel(props: PanelProps) {
  const { docId, listing, problem, composing, asking } = props;
  const [showResolved, setShowResolved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  /** Do a change, say why not in words, and read the comments again. */
  const act = useCallback(
    async (run: () => Promise<{ ok: true } | { ok: false; message: string }>): Promise<boolean> => {
      setError(null);
      const done = await run();
      if (!done.ok) setError(done.message);
      await props.changed();
      return done.ok;
    },
    [props],
  );

  if (!listing) {
    return (
      <section aria-label="Comments" data-testid="comments-panel">
        <h3>Comments</h3>
        {problem ? (
          <Alert variant="error" heading="Comments">
            {problem}
          </Alert>
        ) : (
          <p className={styles.itemMeta}>Loading…</p>
        )}
      </section>
    );
  }

  const { viewer } = listing;
  const threads = listing.threads.filter((thread) => showResolved || !thread.resolved);
  const open = listing.threads.filter((thread) => !thread.resolved).length;
  return (
    <section aria-label="Comments" data-testid="comments-panel">
      <h3>
        Comments{" "}
        <span className={styles.itemMeta} data-testid="comment-count">
          {open === 1 ? "1 open" : `${open} open`}
          {listing.threads.length > open ? `, ${listing.threads.length - open} resolved` : ""}
        </span>
      </h3>
      {problem ? (
        <Alert variant="error" heading="Comments">
          {problem}
        </Alert>
      ) : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Not done">
            {error}
          </Alert>
        </div>
      ) : null}
      {listing.closed ? (
        <div className={styles.notice}>
          <Alert variant="info" heading="Comments are closed">
            Nothing can be added, edited or resolved{viewer.canModerate ? "" : "; the owner can open them again"}. Comments can still be deleted.
          </Alert>
        </div>
      ) : null}
      {viewer.canModerate ? (
        <p>
          <Button variant="secondary" size="sm" onClick={() => void act(() => setClosed(docId, !listing.closed))}>
            {listing.closed ? "Open comments" : "Close comments"}
          </Button>
        </p>
      ) : null}

      {asking ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            props.chooseName(name);
          }}
        >
          <FormField label="Your name" hint="Shown on what you write. Nothing else is asked.">
            {(field) => <Input {...field} name="commenter" autoComplete="nickname" maxLength={MAX_NAME_CHARS} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" size="sm" disabled={cleanGuestName(name) === undefined}>
              Continue
            </Button>{" "}
            <Button variant="secondary" size="sm" onClick={() => props.chooseName(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {composing ? (
        <Composer
          label="New comment"
          quote={composing.type === "text-quote" ? composing.quote : ""}
          submit="Comment"
          onCancel={props.stopComposing}
          onSubmit={async (body) => {
            if (!(await props.needName())) return false;
            const ok = await act(() => startThread(docId, composing, body, props.claim()));
            if (ok) props.stopComposing();
            return ok;
          }}
        />
      ) : null}

      {listing.threads.some((thread) => thread.resolved) ? (
        <label>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      ) : null}
      {listing.threads.length === 0 ? <p>{viewer.canComment ? "No comments yet. Select some text and choose “Comment on selection”." : "No comments."}</p> : null}
      <ul aria-label="Comment threads" className={styles.list}>
        {threads.map((thread) => (
          <ThreadItem key={thread.id} {...props} thread={thread} viewer={viewer} closed={listing.closed} act={act} />
        ))}
      </ul>
    </section>
  );
}

const when = (ms: number) => new Date(ms).toLocaleString();

function Who({ name, kind, createdAt, editedAt }: { name: string; kind: "account" | "guest"; createdAt: number; editedAt: number | null }) {
  return (
    <span className={styles.itemMeta}>
      <strong>{name}</strong>
      {kind === "guest" ? (
        <>
          {" "}
          <Badge>Guest</Badge>
        </>
      ) : null}{" "}
      · {when(createdAt)}
      {editedAt !== null ? " · edited" : ""}
    </span>
  );
}

function ThreadItem(props: PanelProps & { thread: ThreadView; viewer: Listing["viewer"]; closed: boolean; act: (run: () => Promise<{ ok: true } | { ok: false; message: string }>) => Promise<boolean> }) {
  const { thread, viewer, closed, docId, act } = props;
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const claim = props.claim;
  const mayDelete = thread.mine || viewer.canModerate;

  return (
    <li id={`comment-thread-${thread.id}`} className={styles.item} data-testid="comment-thread" data-resolved={thread.resolved} data-active={props.active === thread.id}>
      <div onClick={() => props.choose(thread.id)}>
        <blockquote className={styles.itemMeta}>“{thread.anchor.quote.length > 140 ? `${thread.anchor.quote.slice(0, 140)}…` : thread.anchor.quote}”</blockquote>
        <Who name={thread.authorName} kind={thread.authorKind} createdAt={thread.createdAt} editedAt={thread.editedAt} />{" "}
        {thread.resolved ? <Badge>Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ""}</Badge> : null}
        {props.fates.get(thread.id) === "outdated" ? (
          <span data-testid="comment-outdated" title="The text this was about has been changed or removed, so it is not marked in the document. The comment is kept.">
            {" "}
            <Badge>Outdated</Badge>
          </span>
        ) : null}
        {editing ? (
          <Composer
            label="Edit comment"
            initial={thread.body}
            submit="Save"
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              const ok = await act(() => editComment(docId, "thread", thread.id, body, claim()));
              if (ok) setEditing(false);
              return ok;
            }}
          />
        ) : (
          <p style={{ whiteSpace: "pre-wrap" }}>{thread.body}</p>
        )}
      </div>
      <div>
        {thread.replies.map((reply) => (
          <ReplyItem key={reply.id} {...props} reply={reply} />
        ))}
      </div>
      {replying ? (
        <Composer
          label="Reply"
          submit="Reply"
          onCancel={() => setReplying(false)}
          onSubmit={async (body) => {
            if (!(await props.needName())) return false;
            const ok = await act(() => addReply(docId, thread.id, body, claim()));
            if (ok) setReplying(false);
            return ok;
          }}
        />
      ) : null}
      <p>
        {viewer.canComment && !closed && !replying ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setReplying(true)}>
              Reply
            </Button>{" "}
            <Button variant="secondary" size="sm" onClick={async () => (await props.needName()) && void act(() => setResolved(docId, thread.id, !thread.resolved, claim()))}>
              {thread.resolved ? "Reopen" : "Resolve"}
            </Button>{" "}
          </>
        ) : null}
        {thread.mine && !closed && !editing ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>{" "}
          </>
        ) : null}
        {mayDelete ? (
          deleting ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void act(() => deleteComment(docId, "thread", thread.id, claim()))}>
                Yes, delete
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setDeleting(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setDeleting(true)} aria-label={thread.mine ? "Delete your comment" : `Delete ${thread.authorName}'s comment`}>
              Delete
            </Button>
          )
        ) : null}
      </p>
    </li>
  );
}

function ReplyItem(props: PanelProps & { thread: ThreadView; viewer: Listing["viewer"]; closed: boolean; reply: ReplyView; act: (run: () => Promise<{ ok: true } | { ok: false; message: string }>) => Promise<boolean> }) {
  const { reply, thread, viewer, closed, docId, act } = props;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mayDelete = reply.mine || viewer.canModerate;
  return (
    <div className={styles.itemMeta} style={{ marginLeft: "1rem" }} data-testid="comment-reply">
      <Who name={reply.authorName} kind={reply.authorKind} createdAt={reply.createdAt} editedAt={reply.editedAt} />
      {editing ? (
        <Composer
          label="Edit reply"
          initial={reply.body}
          submit="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const ok = await act(() => editComment(docId, "reply", reply.id, body, props.claim()));
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <p style={{ whiteSpace: "pre-wrap" }}>{reply.body}</p>
      )}
      <p>
        {reply.mine && !closed && !editing ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} aria-label="Edit your reply">
              Edit
            </Button>{" "}
          </>
        ) : null}
        {mayDelete ? (
          deleting ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void act(() => deleteComment(docId, "reply", reply.id, props.claim()))}>
                Yes, delete
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setDeleting(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setDeleting(true)} aria-label={reply.mine ? "Delete your reply" : `Delete ${reply.authorName}'s reply`}>
              Delete
            </Button>
          )
        ) : null}
      </p>
      <span hidden>{thread.id}</span>
    </div>
  );
}

/** A box to write a comment in: for a new thread, a reply or an edit. Cleared and closed by the caller when it is taken. */
function Composer({ label, quote, initial = "", submit, onSubmit, onCancel }: { label: string; quote?: string; initial?: string; submit: string; onSubmit: (body: string) => Promise<boolean>; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSubmit(text).then((ok) => {
          setBusy(false);
          if (ok) setText("");
        });
      }}
    >
      {quote ? <blockquote className={styles.itemMeta}>“{quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}”</blockquote> : null}
      <label>
        <span className={styles.itemMeta}>{label}</span>
        <textarea aria-label={label} value={text} maxLength={MAX_COMMENT_CHARS} rows={3} onChange={(e) => setText(e.target.value)} disabled={busy} style={{ width: "100%" }} />
      </label>
      <div className={styles.actions}>
        <Button type="submit" size="sm" loading={busy} disabled={text.trim() === ""}>
          {submit}
        </Button>{" "}
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
