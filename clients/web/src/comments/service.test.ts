import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { type Author, CommentService, MAX_COMMENT_CHARS, MAX_REPLIES_PER_AUTHOR, MAX_REPLIES_PER_THREAD, MAX_THREADS_PER_AUTHOR, MAX_THREADS_PER_DOCUMENT, MAX_THREADS_PER_LINK, type TextQuoteAnchor, cleanAnchor, cleanBody } from "./service";

/** A document's comments, over the real databases (ROADMAP 1d.1). */
const { leg } = testTarget();
let database: Database;
let comments: CommentService;
let clock = 1_800_000_000_000;
const schema = () => (database.dialect === "postgres" ? postgresSchema : sqliteSchema);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  comments = new CommentService(database, () => clock++);
});
afterAll(async () => database.close());
beforeEach(async () => {
  for (const table of [schema().commentReply, schema().commentThread, schema().commentActivity, schema().commentClosed]) await dbRun(database, sql`DELETE FROM ${table}`);
});

const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const OTHER = "01jagc4k7pt8y3wqnmzv5xrb9k";
const ALICE: Author = { kind: "account", id: "alice", name: "Alice" };
const BOB: Author = { kind: "account", id: "bob", name: "Bob" };
const GUEST: Author = { kind: "guest", id: "3:browser-a", name: "Grace" };
const ANCHOR: TextQuoteAnchor = { type: "text-quote", quote: "world", prefix: "Hello ", suffix: "", position: 6 };
const made = async (author: Author = ALICE, body = "A thought", connection = 1, doc = DOC) => {
  const result = await comments.createThread(connection, doc, ANCHOR, body, author);
  if (!result.ok) throw new Error(`not made: ${result.reason}`);
  return result.id;
};

describe("what a comment may be", () => {
  it("is text of 1 to 4000 characters, tidied, without a NUL or half a character", () => {
    expect(cleanBody("  hello\r\nthere  ")).toBe("hello\nthere");
    expect(cleanBody("a".repeat(MAX_COMMENT_CHARS))).toHaveLength(MAX_COMMENT_CHARS);
    for (const bad of ["", "   \n", "a".repeat(MAX_COMMENT_CHARS + 1), "a\u0000b", "a\ud800", 7, null, undefined]) expect(cleanBody(bad), String(bad)).toBeUndefined();
  });

  it("keeps an anchor as a quote with its surroundings, and refuses one a thread cannot be made with", () => {
    expect(cleanAnchor(ANCHOR)).toEqual(ANCHOR);
    expect(cleanAnchor({ ...ANCHOR, extra: "dropped" })).toEqual(ANCHOR);
    for (const bad of [null, "x", {}, { ...ANCHOR, type: "yjs" }, { ...ANCHOR, quote: "  " }, { ...ANCHOR, quote: "x".repeat(2001) }, { ...ANCHOR, prefix: "x".repeat(201) }, { ...ANCHOR, position: -1 }, { ...ANCHOR, position: 1.5 }, { ...ANCHOR, quote: "a\u0000" }, { ...ANCHOR, suffix: 5 }]) {
      expect(cleanAnchor(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe(`threads and replies (${leg})`, () => {
  it("makes a thread on a selection, and lists it with its author, its anchor and its replies, oldest first", async () => {
    const thread = await made(ALICE, "Is this right?");
    await comments.reply(1, DOC, thread, "I think so", BOB);
    await comments.reply(1, DOC, thread, "Me too", GUEST);
    const { threads, closed } = await comments.list(1, DOC, ALICE);
    expect(closed).toBe(false);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: thread, anchor: ANCHOR, body: "Is this right?", authorKind: "account", authorName: "Alice", resolved: false, resolvedBy: null, editedAt: null, mine: true });
    expect(threads[0]!.replies.map((reply) => [reply.authorName, reply.authorKind, reply.body, reply.mine])).toEqual([["Bob", "account", "I think so", false], ["Grace", "guest", "Me too", false]]);
  });

  it("never lists who wrote a comment by anything but name and kind: no ids", async () => {
    const thread = await made(GUEST);
    await comments.reply(1, DOC, thread, "x", ALICE);
    expect(JSON.stringify(await comments.list(1, DOC, undefined))).not.toMatch(/browser-a|"alice"|authorId/);
  });

  it("says which comments are the asker's own, for an account and for a guest by its browser", async () => {
    const thread = await made(ALICE);
    await comments.reply(1, DOC, thread, "mine too", GUEST);
    const asGuest = (await comments.list(1, DOC, GUEST)).threads[0]!;
    expect([asGuest.mine, asGuest.replies[0]!.mine]).toEqual([false, true]);
    const another = (await comments.list(1, DOC, { ...GUEST, id: "3:browser-b" })).threads[0]!;
    expect(another.replies[0]!.mine).toBe(false);
    const nobody = (await comments.list(1, DOC, undefined)).threads[0]!;
    expect([nobody.mine, nobody.replies[0]!.mine]).toEqual([false, false]);
  });

  it("keeps each document's, and each connection's, apart", async () => {
    await made(ALICE, "here");
    await made(ALICE, "other document", 1, OTHER);
    await made(ALICE, "other connection", 2, DOC);
    expect((await comments.list(1, DOC, ALICE)).threads.map((t) => t.body)).toEqual(["here"]);
    expect((await comments.list(1, OTHER, ALICE)).threads.map((t) => t.body)).toEqual(["other document"]);
    expect((await comments.list(2, DOC, ALICE)).threads.map((t) => t.body)).toEqual(["other connection"]);
  });

  it("will not make a thread or a reply of text that is not a comment, nor reply to a thread of another document", async () => {
    expect(await comments.createThread(1, DOC, ANCHOR, "   ", ALICE)).toEqual({ ok: false, reason: "bad_comment" });
    const thread = await made();
    expect(await comments.reply(1, DOC, thread, "", BOB)).toEqual({ ok: false, reason: "bad_comment" });
    expect(await comments.reply(1, OTHER, thread, "wrong document", BOB)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.reply(2, DOC, thread, "wrong connection", BOB)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.reply(1, DOC, 999_999, "no such thread", BOB)).toEqual({ ok: false, reason: "not_found" });
  });

  it("keeps Unicode, line breaks and an emoji as written", async () => {
    await made(ALICE, "Zoë 🌊\nsecond line — 日本語");
    expect((await comments.list(1, DOC, ALICE)).threads[0]!.body).toBe("Zoë 🌊\nsecond line — 日本語");
  });

  it("allows only so many threads in a document, and so many replies in a thread", async () => {
    // By many authors, so that it is the document's limit that is met and not one author's share of it.
    for (let i = 0; i < MAX_THREADS_PER_DOCUMENT; i++) await made({ kind: "account", id: `author-${i}`, name: "A" }, `t${i}`);
    expect(await comments.createThread(1, DOC, ANCHOR, "one more", ALICE)).toEqual({ ok: false, reason: "too_many" });
    expect((await comments.createThread(1, OTHER, ANCHOR, "elsewhere", ALICE)).ok).toBe(true);
    await dbRun(database, sql`DELETE FROM ${schema().commentThread}`);
    const thread = await made();
    for (let i = 0; i < MAX_REPLIES_PER_THREAD; i++) await comments.reply(1, DOC, thread, `r${i}`, { kind: "account", id: `replier-${i}`, name: "R" });
    expect(await comments.reply(1, DOC, thread, "one more", BOB)).toEqual({ ok: false, reason: "too_many" });
  }, 120_000);

  it("keeps one person from taking more than their share: of the threads, of a thread's replies, and a link's guests together", async () => {
    for (let i = 0; i < MAX_THREADS_PER_AUTHOR; i++) await made(ALICE, `a${i}`);
    expect(await comments.createThread(1, DOC, ANCHOR, "one more", ALICE)).toEqual({ ok: false, reason: "own_limit" });
    expect((await comments.createThread(1, DOC, ANCHOR, "someone else", BOB)).ok, "others still can").toBe(true);
    expect((await comments.createThread(1, OTHER, ANCHOR, "elsewhere", ALICE)).ok, "another document").toBe(true);
    expect((await comments.createThread(2, DOC, ANCHOR, "elsewhere", ALICE)).ok, "another connection").toBe(true);
    // Deleting makes room again.
    const first = (await comments.list(1, DOC, ALICE)).threads.find((thread) => thread.mine)!;
    await comments.remove(1, DOC, { kind: "thread", id: first.id }, ALICE, false);
    expect((await comments.createThread(1, DOC, ANCHOR, "room again", ALICE)).ok).toBe(true);

    const thread = await made(BOB, "a thread to answer");
    for (let i = 0; i < MAX_REPLIES_PER_AUTHOR; i++) expect((await comments.reply(1, DOC, thread, `r${i}`, ALICE)).ok, `reply ${i}`).toBe(true);
    expect(await comments.reply(1, DOC, thread, "one more", ALICE)).toEqual({ ok: false, reason: "own_limit" });
    expect((await comments.reply(1, DOC, thread, "mine", BOB)).ok, "another may still").toBe(true);
  }, 60_000);

  it("keeps a link's guests, whatever browser ids they make up, to the link's share of the threads", async () => {
    await dbRun(database, sql`DELETE FROM ${schema().commentThread}`);
    for (let i = 0; i < MAX_THREADS_PER_LINK; i++) expect((await comments.createThread(1, DOC, ANCHOR, `g${i}`, { kind: "guest", id: `3:browser-${i}`, name: "Guest" })).ok, `thread ${i}`).toBe(true);
    expect(await comments.createThread(1, DOC, ANCHOR, "a new browser", { kind: "guest", id: "3:browser-new", name: "Guest" })).toEqual({ ok: false, reason: "own_limit" });
    expect((await comments.createThread(1, DOC, ANCHOR, "another link", { kind: "guest", id: "4:browser-new", name: "Guest" })).ok, "another link").toBe(true);
    expect((await comments.createThread(1, DOC, ANCHOR, "an account", ALICE)).ok, "an account").toBe(true);
    expect((await comments.createThread(1, DOC, ANCHOR, "link 33 is not link 3", { kind: "guest", id: "33:browser-x", name: "Guest" })).ok, "a link whose number begins with this one's").toBe(true);
  }, 60_000);
});

describe(`resolving (${leg})`, () => {
  it("resolves a thread, naming who, and opens it again", async () => {
    const thread = await made(ALICE);
    expect(await comments.setResolved(1, DOC, thread, true, BOB)).toEqual({ ok: true });
    expect((await comments.list(1, DOC, ALICE)).threads[0]).toMatchObject({ resolved: true, resolvedBy: "Bob" });
    expect(await comments.setResolved(1, DOC, thread, false, GUEST)).toEqual({ ok: true });
    expect((await comments.list(1, DOC, ALICE)).threads[0]).toMatchObject({ resolved: false, resolvedBy: null });
  });

  it("is of a thread of that document only", async () => {
    const thread = await made(ALICE);
    expect(await comments.setResolved(1, OTHER, thread, true, BOB)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.setResolved(2, DOC, thread, true, BOB)).toEqual({ ok: false, reason: "not_found" });
    expect((await comments.list(1, DOC, ALICE)).threads[0]!.resolved).toBe(false);
  });
});

describe(`editing and deleting (${leg})`, () => {
  it("edits one's own comment and no one else's, marking it edited", async () => {
    const thread = await made(ALICE, "first");
    const reply = (await comments.reply(1, DOC, thread, "reply", BOB)) as { ok: true; id: number };
    expect(await comments.edit(1, DOC, { kind: "thread", id: thread }, "first, better", ALICE)).toEqual({ ok: true });
    expect(await comments.edit(1, DOC, { kind: "reply", id: reply.id }, "reply, better", BOB)).toEqual({ ok: true });
    expect(await comments.edit(1, DOC, { kind: "thread", id: thread }, "vandalised", BOB)).toEqual({ ok: false, reason: "forbidden" });
    expect(await comments.edit(1, DOC, { kind: "reply", id: reply.id }, "vandalised", GUEST)).toEqual({ ok: false, reason: "forbidden" });
    const listed = (await comments.list(1, DOC, ALICE)).threads[0]!;
    expect(listed.body).toBe("first, better");
    expect(listed.editedAt).not.toBeNull();
    expect(listed.replies[0]).toMatchObject({ body: "reply, better" });
    expect(listed.replies[0]!.editedAt).not.toBeNull();
  });

  it("will not edit to nothing, or something that is not text, or a comment of another document", async () => {
    const thread = await made(ALICE);
    expect(await comments.edit(1, DOC, { kind: "thread", id: thread }, "  ", ALICE)).toEqual({ ok: false, reason: "bad_comment" });
    expect(await comments.edit(1, OTHER, { kind: "thread", id: thread }, "x", ALICE)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.edit(1, DOC, { kind: "reply", id: thread }, "x", ALICE)).toEqual({ ok: false, reason: "not_found" }); // a thread's id is not a reply's
  });

  it("deletes one's own comment, and the owner may delete anyone's; a guest can delete their own from the same browser only", async () => {
    const thread = await made(ALICE);
    const own = (await comments.reply(1, DOC, thread, "bob's", BOB)) as { ok: true; id: number };
    const guests = (await comments.reply(1, DOC, thread, "grace's", GUEST)) as { ok: true; id: number };
    expect(await comments.remove(1, DOC, { kind: "reply", id: own.id }, ALICE, false)).toEqual({ ok: false, reason: "forbidden" });
    expect(await comments.remove(1, DOC, { kind: "reply", id: guests.id }, { ...GUEST, id: "3:browser-b" }, false)).toEqual({ ok: false, reason: "forbidden" });
    expect(await comments.remove(1, DOC, { kind: "reply", id: own.id }, BOB, false)).toEqual({ ok: true });
    expect(await comments.remove(1, DOC, { kind: "reply", id: guests.id }, ALICE, true)).toEqual({ ok: true });
    expect((await comments.list(1, DOC, ALICE)).threads[0]!.replies).toEqual([]);
    expect(await comments.remove(1, DOC, { kind: "thread", id: thread }, BOB, false)).toEqual({ ok: false, reason: "forbidden" });
    expect(await comments.remove(1, DOC, { kind: "thread", id: thread }, ALICE, false)).toEqual({ ok: true });
    expect((await comments.list(1, DOC, ALICE)).threads).toEqual([]);
  });

  it("takes a thread's replies with it, and nothing else", async () => {
    const one = await made(ALICE, "one");
    const two = await made(ALICE, "two");
    await comments.reply(1, DOC, one, "reply to one", BOB);
    await comments.reply(1, DOC, two, "reply to two", BOB);
    await comments.remove(1, DOC, { kind: "thread", id: one }, ALICE, false);
    const { threads } = await comments.list(1, DOC, ALICE);
    expect(threads.map((t) => [t.body, t.replies.map((r) => r.body)])).toEqual([["two", ["reply to two"]]]);
    // Not merely out of sight: the rows are gone.
    const left = await dbAll<{ n: number | string }>(database, sql`SELECT COUNT(*) AS n FROM ${schema().commentReply}`);
    expect(Number(left[0]!.n)).toBe(1);
  });

  it("is of that document's comments only", async () => {
    const thread = await made(ALICE);
    expect(await comments.remove(1, OTHER, { kind: "thread", id: thread }, ALICE, true)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.remove(2, DOC, { kind: "thread", id: thread }, ALICE, true)).toEqual({ ok: false, reason: "not_found" });
    expect((await comments.list(1, DOC, ALICE)).threads).toHaveLength(1);
  });
});

describe(`closing a document's comments (${leg})`, () => {
  it("stops anything being added, edited or resolved, and not deleting, until they are opened again", async () => {
    const thread = await made(ALICE);
    await comments.setClosed(1, DOC, true, ALICE);
    expect((await comments.list(1, DOC, ALICE)).closed).toBe(true);
    expect(await comments.createThread(1, DOC, ANCHOR, "new", BOB)).toEqual({ ok: false, reason: "closed" });
    expect(await comments.reply(1, DOC, thread, "reply", BOB)).toEqual({ ok: false, reason: "closed" });
    expect(await comments.edit(1, DOC, { kind: "thread", id: thread }, "edited", ALICE)).toEqual({ ok: false, reason: "closed" });
    expect(await comments.setResolved(1, DOC, thread, true, BOB)).toEqual({ ok: false, reason: "closed" });
    expect((await comments.createThread(1, OTHER, ANCHOR, "another document is open", BOB)).ok).toBe(true);
    await comments.setClosed(1, DOC, false, ALICE);
    expect((await comments.reply(1, DOC, thread, "reply", BOB)).ok).toBe(true);
    await comments.setClosed(1, DOC, true, ALICE);
    expect(await comments.remove(1, DOC, { kind: "thread", id: thread }, ALICE, false)).toEqual({ ok: true });
  });

  it("closes once however often it is asked, and opening what is open is nothing", async () => {
    await comments.setClosed(1, DOC, true, ALICE);
    await comments.setClosed(1, DOC, true, ALICE);
    await comments.setClosed(1, DOC, false, ALICE);
    await comments.setClosed(1, DOC, false, ALICE);
    expect((await comments.list(1, DOC, ALICE)).closed).toBe(false);
  });
});

describe(`the log of what happened (${leg})`, () => {
  it("says who did what to which thread, newest first", async () => {
    const thread = await made(ALICE);
    await comments.reply(1, DOC, thread, "r", BOB);
    await comments.setResolved(1, DOC, thread, true, GUEST);
    await comments.edit(1, DOC, { kind: "thread", id: thread }, "e", ALICE);
    await comments.setClosed(1, DOC, true, ALICE);
    await comments.remove(1, DOC, { kind: "thread", id: thread }, ALICE, false);
    const log = await comments.activity(1, DOC);
    expect(log.map((entry) => [entry.actorName, entry.event])).toEqual([["Alice", "deleted"], ["Alice", "comments_closed"], ["Alice", "edited"], ["Grace", "resolved"], ["Bob", "reply_added"], ["Alice", "thread_created"]]);
    expect(log[0]!.threadId).toBe(thread);
    expect(log[1]!.threadId).toBeNull();
  });

  it("says when the owner took away someone else's comment", async () => {
    const thread = await made(BOB);
    await comments.remove(1, DOC, { kind: "thread", id: thread }, ALICE, true);
    expect((await comments.activity(1, DOC))[0]).toMatchObject({ actorName: "Alice", event: "deleted_by_owner" });
  });
});

describe(`moving a thread onto the words its text was edited into (${leg})`, () => {
  const EDITED: TextQuoteAnchor = { type: "text-quote", quote: "worlds", prefix: "Hello ", suffix: "!", position: 6 };
  const anchorOf = async (id: number) => (await comments.list(1, DOC, ALICE)).threads.find((thread) => thread.id === id)!.anchor;

  it("keeps the new anchor in place of the old, and leaves the comment, the replies and the resolving as they were", async () => {
    const id = await made();
    await comments.reply(1, DOC, id, "yes", BOB);
    await comments.setResolved(1, DOC, id, true, BOB);
    expect(await comments.reanchor(1, DOC, id, ANCHOR, EDITED)).toEqual({ ok: true });
    const thread = (await comments.list(1, DOC, ALICE)).threads[0]!;
    expect(thread).toMatchObject({ anchor: EDITED, body: "A thought", resolved: true, editedAt: null });
    expect(thread.replies).toHaveLength(1);
  });

  it("goes on being followed: the next move is from the one before", async () => {
    const id = await made();
    expect((await comments.reanchor(1, DOC, id, ANCHOR, EDITED)).ok).toBe(true);
    expect((await comments.reanchor(1, DOC, id, EDITED, { ...EDITED, quote: "worlds!" })).ok).toBe(true);
    expect((await anchorOf(id)).quote).toBe("worlds!");
  });

  it("is refused for a page that has not seen a move since: the anchor is not what it was found with, and nothing changes", async () => {
    const id = await made();
    await comments.reanchor(1, DOC, id, ANCHOR, EDITED);
    expect(await comments.reanchor(1, DOC, id, ANCHOR, { ...ANCHOR, quote: "wor1d" })).toEqual({ ok: false, reason: "stale" });
    expect(await anchorOf(id)).toEqual(EDITED);
  });

  it("is refused for words that are not like the old ones, and nothing changes", async () => {
    const id = await made(ALICE, "A thought");
    const long: TextQuoteAnchor = { ...ANCHOR, quote: "The quick brown fox jumps over the lazy dog." };
    await dbRun(database, sql`UPDATE ${schema().commentThread} SET anchor = ${JSON.stringify(long)} WHERE id = ${id}`);
    expect(await comments.reanchor(1, DOC, id, long, { ...long, quote: "Something else altogether, about boats." })).toEqual({ ok: false, reason: "bad_anchor" });
    expect(await anchorOf(id)).toEqual(long);
  });

  it("is of that document's thread only", async () => {
    const id = await made();
    expect(await comments.reanchor(1, OTHER, id, ANCHOR, EDITED)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.reanchor(2, DOC, id, ANCHOR, EDITED)).toEqual({ ok: false, reason: "not_found" });
    expect(await comments.reanchor(1, DOC, id + 100, ANCHOR, EDITED)).toEqual({ ok: false, reason: "not_found" });
    expect(await anchorOf(id)).toEqual(ANCHOR);
  });

  it("works while the comments are closed, and is in the log as the page's doing, not a person's", async () => {
    const id = await made();
    await comments.setClosed(1, DOC, true, ALICE);
    expect((await comments.reanchor(1, DOC, id, ANCHOR, EDITED)).ok).toBe(true);
    expect((await comments.activity(1, DOC))[0]).toMatchObject({ threadId: id, actorKind: "page", event: "reanchored" });
  });
});

describe(`where a document's comments are up to (${leg})`, () => {
  it("is 0 before anything, and goes up with every kind of change, to every document's own count", async () => {
    expect(await comments.version(1, DOC)).toBe(0);
    const seen: number[] = [];
    const note = async () => void seen.push(await comments.version(1, DOC));
    const id = await made();
    await note();
    const reply = await comments.reply(1, DOC, id, "yes", BOB);
    await note();
    await comments.setResolved(1, DOC, id, true, BOB);
    await note();
    await comments.edit(1, DOC, { kind: "thread", id }, "better", ALICE);
    await note();
    await comments.reanchor(1, DOC, id, ANCHOR, { ...ANCHOR, quote: "worlds" });
    await note();
    await comments.setClosed(1, DOC, true, ALICE);
    await note();
    await comments.remove(1, DOC, { kind: "reply", id: reply.ok ? reply.id : 0 }, BOB, true);
    await note();
    for (let i = 1; i < seen.length; i++) expect(seen[i]!, `step ${i}`).toBeGreaterThan(seen[i - 1]!);
    expect(await comments.version(1, OTHER)).toBe(0);
    expect(await comments.version(2, DOC)).toBe(0);
  });

  it("does not move for what changes nothing: a refused change, and reading", async () => {
    const id = await made();
    const before = await comments.version(1, DOC);
    await comments.list(1, DOC, ALICE);
    await comments.reply(1, DOC, id, "   ", BOB); // not a comment
    await comments.edit(1, DOC, { kind: "thread", id }, "hijack", BOB); // not theirs
    await comments.reanchor(1, DOC, id, { ...ANCHOR, quote: "stale" }, ANCHOR); // not where it was
    expect(await comments.version(1, DOC)).toBe(before);
  });

  it("is what a listing says it was read at, and is read before the comments, so that a change while reading is seen", async () => {
    await made();
    const listed = await comments.list(1, DOC, ALICE);
    expect(listed.version).toBe(await comments.version(1, DOC));
  });

  it("tells the process of every change, and of no refused one", async () => {
    const told: [number, string][] = [];
    const watched = new CommentService(database, () => clock++, (connection, doc) => void told.push([connection, doc]));
    const made2 = await watched.createThread(1, DOC, ANCHOR, "hi", ALICE);
    if (!made2.ok) throw new Error("not made");
    await watched.reply(1, DOC, made2.id, "re", BOB);
    await watched.reply(1, DOC, made2.id, "  ", BOB);
    await watched.edit(1, DOC, { kind: "thread", id: made2.id }, "x", BOB);
    expect(told).toEqual([[1, DOC], [1, DOC]]);
  });
});

describe(`forgetting a connection (${leg})`, () => {
  it("takes its comments, replies, log and closing, and no other connection's", async () => {
    const one = await made(ALICE, "one", 1);
    await comments.reply(1, DOC, one, "r", BOB);
    await comments.setClosed(1, OTHER, true, ALICE);
    await made(ALICE, "two", 2);
    await comments.forget(1);
    expect((await comments.list(1, DOC, ALICE)).threads).toEqual([]);
    expect((await comments.list(1, OTHER, ALICE)).closed).toBe(false);
    expect(await comments.activity(1, DOC)).toEqual([]);
    expect((await comments.list(2, DOC, ALICE)).threads).toHaveLength(1);
  });
});
