import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { type Author, CommentService, MAX_COMMENT_CHARS, MAX_REPLIES_PER_THREAD, MAX_THREADS_PER_DOCUMENT, type TextQuoteAnchor, cleanAnchor, cleanBody } from "./service";

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
    for (let i = 0; i < MAX_THREADS_PER_DOCUMENT; i++) await made(ALICE, `t${i}`);
    expect(await comments.createThread(1, DOC, ANCHOR, "one more", ALICE)).toEqual({ ok: false, reason: "too_many" });
    expect((await comments.createThread(1, OTHER, ANCHOR, "elsewhere", ALICE)).ok).toBe(true);
    await dbRun(database, sql`DELETE FROM ${schema().commentThread}`);
    const thread = await made();
    for (let i = 0; i < MAX_REPLIES_PER_THREAD; i++) await comments.reply(1, DOC, thread, `r${i}`, BOB);
    expect(await comments.reply(1, DOC, thread, "one more", BOB)).toEqual({ ok: false, reason: "too_many" });
  }, 120_000);
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
