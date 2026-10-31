import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { MAX_COMMENT_CHARS } from "./limits";
import { isLike } from "./similar";

/**
 * A document's comments (DESIGN.md §13, ROADMAP 1d.1): threads on a selection, replies, resolving, editing and deleting, and the owner's
 * closing of a document's comments. Kept on the server, not in the repository, per document (its connection and Doc `id`, so they follow
 * the file through a rename or a move). This is only the record and its rules about *content*: who may do what is `access/policy.ts`'s,
 * decided before anything here is called, except that an edit or a delete is of the author's own comment (the service finds whose it is).
 *
 *  - **Identity:** a signed-in account by its id; someone who came through a link by the link and a random id their browser made up, with the
 *    name they gave. A guest's id is spoofable by design: it only tells their own comments apart in the one browser that made them.
 *  - **Limits:** a comment is 1 to 4000 characters, a document has at most 500 threads and a thread at most 200 replies, an anchor's quote at
 *    most 2000 characters. Further limits, per user and per link, come with ROADMAP 1d.4.
 *  - **Closed:** while a document's comments are closed, nothing is added, edited or resolved; deleting goes on.
 *  - **Nothing is dropped:** an anchor is kept as it was made, and a thread whose text is gone is kept with it. Finding the text again after a
 *    change is the browser's, which sees the text (`fjord-editor`'s `reanchor.ts`, ROADMAP 1d.2); what it asks of the server is `reanchor`: to move a
 *    thread's anchor onto the edited words, only from the anchor it was found with (so a page that is out of date cannot undo a newer move), and
 *    only onto words like the old ones.
 */
export type Author = { kind: "account" | "guest"; id: string; name: string };

export interface TextQuoteAnchor {
  type: "text-quote";
  quote: string;
  prefix: string;
  suffix: string;
  position: number;
}

export interface Comment {
  id: number;
  body: string;
  authorKind: "account" | "guest";
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  /** Whether the person who asked wrote it. */
  mine: boolean;
}

export interface Thread extends Comment {
  anchor: TextQuoteAnchor;
  resolved: boolean;
  resolvedBy: string | null;
  replies: Comment[];
}

export { MAX_COMMENT_CHARS };
export const MAX_QUOTE_CHARS = 2000;
export const MAX_CONTEXT_CHARS = 200;
export const MAX_THREADS_PER_DOCUMENT = 500;
export const MAX_REPLIES_PER_THREAD = 200;

export type Refusal = "not_found" | "closed" | "forbidden" | "too_many" | "bad_comment" | "bad_anchor" | "stale";
export type Done<T = object> = ({ ok: true } & T) | { ok: false; reason: Refusal };

const tables = (database: Database) =>
  database.dialect === "postgres"
    ? { thread: postgresSchema.commentThread, reply: postgresSchema.commentReply, activity: postgresSchema.commentActivity, closed: postgresSchema.commentClosed }
    : { thread: sqliteSchema.commentThread, reply: sqliteSchema.commentReply, activity: sqliteSchema.commentActivity, closed: sqliteSchema.commentClosed };

interface ThreadRow {
  id: number | string;
  anchor: string;
  body: string;
  authorKind: string;
  authorId: string;
  authorName: string;
  createdAt: number | string;
  editedAt: number | string | null;
  resolvedAt: number | string | null;
  resolvedBy: string | null;
}
interface ReplyRow {
  id: number | string;
  threadId: number | string;
  body: string;
  authorKind: string;
  authorId: string;
  authorName: string;
  createdAt: number | string;
  editedAt: number | string | null;
}

const kindOf = (value: string): "account" | "guest" => (value === "guest" ? "guest" : "account");
const sameAuthor = (row: { authorKind: string; authorId: string }, author: Author) => row.authorKind === author.kind && row.authorId === author.id;

/** The text of a comment as it is kept: not empty, not too long, well-formed, no NUL (PostgreSQL's `text` cannot hold one). */
export function cleanBody(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) return undefined;
  const body = value.replace(/\r\n?/g, "\n").trim();
  return body === "" || [...body].length > MAX_COMMENT_CHARS ? undefined : body;
}

/** An anchor as it is kept, or undefined if it is not one a thread can be made with. */
export function cleanAnchor(value: unknown): TextQuoteAnchor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, quote, prefix, suffix, position } = value as Record<string, unknown>;
  if (type !== "text-quote" || typeof quote !== "string" || typeof prefix !== "string" || typeof suffix !== "string") return undefined;
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) return undefined;
  if (quote.trim() === "" || [...quote].length > MAX_QUOTE_CHARS || [...prefix].length > MAX_CONTEXT_CHARS || [...suffix].length > MAX_CONTEXT_CHARS) return undefined;
  for (const text of [quote, prefix, suffix]) if (!text.isWellFormed() || text.includes("\0")) return undefined;
  return { type: "text-quote", quote, prefix, suffix, position };
}

export class CommentService {
  /**
   * `onChange` is told after every change to a document's comments (which connection, which document): the live updates' way of knowing at once, in
   * this process (ROADMAP 1d.3). Other processes find out from `version`.
   */
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
    private readonly onChange: (connectionId: number, docId: string) => void = () => undefined,
  ) {}

  private t() {
    return tables(this.database);
  }

  async isClosed(connectionId: number, docId: string): Promise<boolean> {
    const row = await dbGet<{ id: number }>(this.database, sql`SELECT id FROM ${this.t().closed} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return row !== undefined;
  }

  /**
   * Where a document's comments are up to: the number of the last thing that happened to them (every change is in the log, which only grows), 0
   * if nothing has. Cheap, and the same in every process, so a page that holds the number it was given with its comments knows by comparing it
   * whether they have changed (ROADMAP 1d.3).
   */
  async version(connectionId: number, docId: string): Promise<number> {
    const row = await dbGet<{ latest: number | string | null }>(this.database, sql`SELECT MAX(id) AS latest FROM ${this.t().activity} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return Number(row?.latest ?? 0);
  }

  /**
   * The document's threads with their replies, oldest first, whether its comments are closed, and the `version` they were read at (read first, so
   * that a change made while they were being read is a later version and is seen); `viewer` is who is asking, for `mine`.
   */
  async list(connectionId: number, docId: string, viewer: Author | undefined): Promise<{ threads: Thread[]; closed: boolean; version: number }> {
    const version = await this.version(connectionId, docId);
    const t = this.t();
    const threads = await dbAll<ThreadRow>(
      this.database,
      sql`SELECT id, anchor, body, author_kind AS "authorKind", author_id AS "authorId", author_name AS "authorName", created_at AS "createdAt", edited_at AS "editedAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy"
          FROM ${t.thread} WHERE connection_id = ${connectionId} AND doc_id = ${docId} ORDER BY created_at ASC, id ASC`,
    );
    const replies = await dbAll<ReplyRow>(
      this.database,
      sql`SELECT id, thread_id AS "threadId", body, author_kind AS "authorKind", author_id AS "authorId", author_name AS "authorName", created_at AS "createdAt", edited_at AS "editedAt"
          FROM ${t.reply} WHERE connection_id = ${connectionId} AND doc_id = ${docId} ORDER BY created_at ASC, id ASC`,
    );
    const byThread = new Map<number, Comment[]>();
    for (const reply of replies) {
      const list = byThread.get(Number(reply.threadId)) ?? [];
      list.push({ id: Number(reply.id), body: reply.body, authorKind: kindOf(reply.authorKind), authorName: reply.authorName, createdAt: Number(reply.createdAt), editedAt: reply.editedAt === null ? null : Number(reply.editedAt), mine: viewer !== undefined && sameAuthor(reply, viewer) });
      byThread.set(Number(reply.threadId), list);
    }
    return {
      version,
      closed: await this.isClosed(connectionId, docId),
      threads: threads.map((row) => ({
        id: Number(row.id),
        anchor: JSON.parse(row.anchor) as TextQuoteAnchor,
        body: row.body,
        authorKind: kindOf(row.authorKind),
        authorName: row.authorName,
        createdAt: Number(row.createdAt),
        editedAt: row.editedAt === null ? null : Number(row.editedAt),
        resolved: row.resolvedAt !== null,
        resolvedBy: row.resolvedBy,
        mine: viewer !== undefined && sameAuthor(row, viewer),
        replies: byThread.get(Number(row.id)) ?? [],
      })),
    };
  }

  private async log(connectionId: number, docId: string, threadId: number | null, actor: { kind: string; name: string }, event: string): Promise<void> {
    await dbRun(this.database, sql`INSERT INTO ${this.t().activity} (connection_id, doc_id, thread_id, actor_kind, actor_name, event, at) VALUES (${connectionId}, ${docId}, ${threadId}, ${actor.kind}, ${actor.name}, ${event}, ${this.now()})`);
    this.onChange(connectionId, docId);
  }

  async createThread(connectionId: number, docId: string, anchor: TextQuoteAnchor, rawBody: unknown, author: Author): Promise<Done<{ id: number }>> {
    const body = cleanBody(rawBody);
    if (body === undefined) return { ok: false, reason: "bad_comment" };
    if (await this.isClosed(connectionId, docId)) return { ok: false, reason: "closed" };
    const t = this.t();
    const count = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${t.thread} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    if (Number(count?.n ?? 0) >= MAX_THREADS_PER_DOCUMENT) return { ok: false, reason: "too_many" };
    const made = await dbAll<{ id: number | string }>(
      this.database,
      sql`INSERT INTO ${t.thread} (connection_id, doc_id, anchor, body, author_kind, author_id, author_name, created_at)
          VALUES (${connectionId}, ${docId}, ${JSON.stringify(anchor)}, ${body}, ${author.kind}, ${author.id}, ${author.name}, ${this.now()}) RETURNING id`,
    );
    const id = Number(made[0]!.id);
    await this.log(connectionId, docId, id, author, "thread_created");
    return { ok: true, id };
  }

  private async thread(connectionId: number, docId: string, id: number): Promise<{ id: number; authorKind: string; authorId: string } | undefined> {
    const row = await dbGet<{ id: number | string; authorKind: string; authorId: string }>(
      this.database,
      sql`SELECT id, author_kind AS "authorKind", author_id AS "authorId" FROM ${this.t().thread} WHERE id = ${id} AND connection_id = ${connectionId} AND doc_id = ${docId}`,
    );
    return row ? { id: Number(row.id), authorKind: row.authorKind, authorId: row.authorId } : undefined;
  }

  async reply(connectionId: number, docId: string, threadId: number, rawBody: unknown, author: Author): Promise<Done<{ id: number }>> {
    const body = cleanBody(rawBody);
    if (body === undefined) return { ok: false, reason: "bad_comment" };
    if (!(await this.thread(connectionId, docId, threadId))) return { ok: false, reason: "not_found" };
    if (await this.isClosed(connectionId, docId)) return { ok: false, reason: "closed" };
    const t = this.t();
    const count = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${t.reply} WHERE thread_id = ${threadId}`);
    if (Number(count?.n ?? 0) >= MAX_REPLIES_PER_THREAD) return { ok: false, reason: "too_many" };
    const made = await dbAll<{ id: number | string }>(
      this.database,
      sql`INSERT INTO ${t.reply} (thread_id, connection_id, doc_id, body, author_kind, author_id, author_name, created_at)
          VALUES (${threadId}, ${connectionId}, ${docId}, ${body}, ${author.kind}, ${author.id}, ${author.name}, ${this.now()}) RETURNING id`,
    );
    await this.log(connectionId, docId, threadId, author, "reply_added");
    return { ok: true, id: Number(made[0]!.id) };
  }

  /**
   * Move a thread onto the words its text was edited into (ROADMAP 1d.2). Only if the thread's anchor is still `from`, the one the browser found
   * it with: a page that has not seen a newer move changes nothing. And only if `to` is like `from`: the server cannot see the text, but it will
   * not move a thread onto unrelated words in one step. Not a comment, so it works while the comments are closed, and not a person's act: it is in the log as the page's, so that
   * everyone looking at the document finds out where the thread is now (ROADMAP 1d.3).
   */
  async reanchor(connectionId: number, docId: string, threadId: number, from: TextQuoteAnchor, to: TextQuoteAnchor): Promise<Done> {
    if (!(await this.thread(connectionId, docId, threadId))) return { ok: false, reason: "not_found" };
    if (!isLike(from.quote, to.quote)) return { ok: false, reason: "bad_anchor" };
    const moved = await dbAll<{ id: number | string }>(
      this.database,
      sql`UPDATE ${this.t().thread} SET anchor = ${JSON.stringify(to)}
          WHERE id = ${threadId} AND connection_id = ${connectionId} AND doc_id = ${docId} AND anchor = ${JSON.stringify(from)}
          RETURNING id`,
    );
    if (moved.length === 0) return { ok: false, reason: "stale" };
    await this.log(connectionId, docId, threadId, { kind: "page", name: "" }, "reanchored");
    return { ok: true };
  }

  /** Resolve a thread, or open it again. Anyone who may comment may; the actor is named on it. */
  async setResolved(connectionId: number, docId: string, threadId: number, resolved: boolean, actor: Author): Promise<Done> {
    if (!(await this.thread(connectionId, docId, threadId))) return { ok: false, reason: "not_found" };
    if (await this.isClosed(connectionId, docId)) return { ok: false, reason: "closed" };
    await dbRun(
      this.database,
      resolved
        ? sql`UPDATE ${this.t().thread} SET resolved_at = ${this.now()}, resolved_by = ${actor.name} WHERE id = ${threadId} AND connection_id = ${connectionId} AND doc_id = ${docId}`
        : sql`UPDATE ${this.t().thread} SET resolved_at = NULL, resolved_by = NULL WHERE id = ${threadId} AND connection_id = ${connectionId} AND doc_id = ${docId}`,
    );
    await this.log(connectionId, docId, threadId, actor, resolved ? "resolved" : "reopened");
    return { ok: true };
  }

  /** Change the text of a thread's opening comment or a reply: the author's own only. */
  async edit(connectionId: number, docId: string, target: { kind: "thread" | "reply"; id: number }, rawBody: unknown, author: Author): Promise<Done> {
    const body = cleanBody(rawBody);
    if (body === undefined) return { ok: false, reason: "bad_comment" };
    const found = await this.owner(connectionId, docId, target);
    if (!found) return { ok: false, reason: "not_found" };
    if (!sameAuthor(found, author)) return { ok: false, reason: "forbidden" };
    if (await this.isClosed(connectionId, docId)) return { ok: false, reason: "closed" };
    const table = target.kind === "thread" ? this.t().thread : this.t().reply;
    await dbRun(this.database, sql`UPDATE ${table} SET body = ${body}, edited_at = ${this.now()} WHERE id = ${target.id} AND connection_id = ${connectionId} AND doc_id = ${docId}`);
    await this.log(connectionId, docId, found.threadId, author, "edited");
    return { ok: true };
  }

  private async owner(connectionId: number, docId: string, target: { kind: "thread" | "reply"; id: number }): Promise<{ authorKind: string; authorId: string; threadId: number } | undefined> {
    if (target.kind === "thread") {
      const row = await this.thread(connectionId, docId, target.id);
      return row ? { authorKind: row.authorKind, authorId: row.authorId, threadId: row.id } : undefined;
    }
    const row = await dbGet<{ authorKind: string; authorId: string; threadId: number | string }>(
      this.database,
      sql`SELECT author_kind AS "authorKind", author_id AS "authorId", thread_id AS "threadId" FROM ${this.t().reply} WHERE id = ${target.id} AND connection_id = ${connectionId} AND doc_id = ${docId}`,
    );
    return row ? { authorKind: row.authorKind, authorId: row.authorId, threadId: Number(row.threadId) } : undefined;
  }

  /**
   * Delete a thread (with its replies) or a reply. The author's own, or anyone's when `moderator` (the owner). Closing a document's comments
   * does not stop deleting.
   */
  async remove(connectionId: number, docId: string, target: { kind: "thread" | "reply"; id: number }, actor: Author, moderator: boolean): Promise<Done> {
    const found = await this.owner(connectionId, docId, target);
    if (!found) return { ok: false, reason: "not_found" };
    if (!moderator && !sameAuthor(found, actor)) return { ok: false, reason: "forbidden" };
    const t = this.t();
    if (target.kind === "thread") {
      await dbRun(this.database, sql`DELETE FROM ${t.reply} WHERE thread_id = ${target.id} AND connection_id = ${connectionId} AND doc_id = ${docId}`);
      await dbRun(this.database, sql`DELETE FROM ${t.thread} WHERE id = ${target.id} AND connection_id = ${connectionId} AND doc_id = ${docId}`);
    } else {
      await dbRun(this.database, sql`DELETE FROM ${t.reply} WHERE id = ${target.id} AND connection_id = ${connectionId} AND doc_id = ${docId}`);
    }
    await this.log(connectionId, docId, found.threadId, actor, moderator && !sameAuthor(found, actor) ? "deleted_by_owner" : "deleted");
    return { ok: true };
  }

  /** Close a document's comments, or open them again (the owner's). */
  async setClosed(connectionId: number, docId: string, closed: boolean, actor: Author): Promise<void> {
    const t = this.t();
    if (closed) {
      await dbRun(this.database, sql`INSERT INTO ${t.closed} (connection_id, doc_id, closed_at) VALUES (${connectionId}, ${docId}, ${this.now()}) ON CONFLICT (connection_id, doc_id) DO NOTHING`);
    } else {
      await dbRun(this.database, sql`DELETE FROM ${t.closed} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    }
    await this.log(connectionId, docId, null, actor, closed ? "comments_closed" : "comments_opened");
  }

  /** The log of what happened to a document's comments, newest first. */
  async activity(connectionId: number, docId: string, limit = 100): Promise<{ threadId: number | null; actorKind: string; actorName: string; event: string; at: number }[]> {
    const rows = await dbAll<{ threadId: number | string | null; actorKind: string; actorName: string; event: string; at: number | string }>(
      this.database,
      sql`SELECT thread_id AS "threadId", actor_kind AS "actorKind", actor_name AS "actorName", event, at FROM ${this.t().activity}
          WHERE connection_id = ${connectionId} AND doc_id = ${docId} ORDER BY at DESC, id DESC LIMIT ${limit}`,
    );
    return rows.map((row) => ({ threadId: row.threadId === null ? null : Number(row.threadId), actorKind: row.actorKind, actorName: row.actorName, event: row.event, at: Number(row.at) }));
  }

  /** Everything of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    const t = this.t();
    for (const table of [t.reply, t.thread, t.activity, t.closed]) await dbRun(this.database, sql`DELETE FROM ${table} WHERE connection_id = ${connectionId}`);
  }
}
