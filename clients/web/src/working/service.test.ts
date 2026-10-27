import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { type Editor, MAX_CONTENT_BYTES, MAX_DRAFTS_PER_CONNECTION, type WorkingCopy, WorkingCopyService, whyUnstorable } from "./service";

/**
 * Drafts over the real databases: that what is typed is kept exactly, that a draft is of one version, that two saves at
 * once lose neither editor, and that what a database cannot hold is refused before it gets there.
 */
const { leg } = testTarget();
let database: Database;
let service: WorkingCopyService;
let clock = 1_800_000_000_000;

const ALICE: Editor = { type: "account", id: "user-alice" };
const BOB: Editor = { type: "account", id: "user-bob" };
const table = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  service = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => {
  await database.close();
});
beforeEach(async () => {
  clock = 1_800_000_000_000;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});

const saved = async (result: ReturnType<WorkingCopyService["save"]>) => {
  const outcome = await result;
  if (!outcome.ok) throw new Error(`expected a saved draft, got ${outcome.reason}`);
  return outcome.workingCopy;
};

describe(`drafts (${leg})`, () => {
  it("has none until something is saved", async () => {
    expect(await service.get(1, "Notes/a.md")).toBeUndefined();
    expect(await service.count(1)).toBe(0);
  });

  it("keeps what was typed, byte for byte, with who typed it and when", async () => {
    const content = "# Title\r\n\r\nlines  \r\nwith trailing space \t\r\n\r\n   ünï 💧 \n\n";
    const copy = await saved(service.save(1, "Notes/a.md", { baseBlob: "blob-1", content }, ALICE));
    expect(copy).toEqual({ path: "Notes/a.md", baseBlob: "blob-1", content, editors: [ALICE], createdAt: clock, lastEdit: clock });
    expect(await service.get(1, "Notes/a.md")).toEqual(copy);
  });

  it("replaces the text on a later save and keeps when the draft was started", async () => {
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "one" }, ALICE));
    clock += 5_000;
    const copy = await saved(service.save(1, "a.md", { baseBlob: "b", content: "two" }, ALICE));
    expect(copy).toMatchObject({ content: "two", createdAt: 1_800_000_000_000, lastEdit: clock, editors: [ALICE] });
  });

  it("lists each editor once, in the order they first edited", async () => {
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "1" }, ALICE));
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "2" }, BOB));
    const copy = await saved(service.save(1, "a.md", { baseBlob: "b", content: "3" }, ALICE));
    expect(copy.editors).toEqual([ALICE, BOB]);
  });

  it("keeps the time of the last edit moving forward even if the clock does not", async () => {
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "1" }, ALICE));
    clock -= 60_000;
    const copy = await saved(service.save(1, "a.md", { baseBlob: "b", content: "2" }, ALICE));
    expect(copy.lastEdit).toBe(1_800_000_000_001);
  });

  it("keeps one draft per file, and drafts of different files and connections apart", async () => {
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "a1" }, ALICE));
    await saved(service.save(1, "b.md", { baseBlob: "b", content: "b1" }, ALICE));
    await saved(service.save(2, "a.md", { baseBlob: "b", content: "a2" }, ALICE));
    expect((await service.get(1, "a.md"))?.content).toBe("a1");
    expect((await service.get(1, "b.md"))?.content).toBe("b1");
    expect((await service.get(2, "a.md"))?.content).toBe("a2");
    expect(await service.count(1)).toBe(2);
    expect(await service.get(1, "A.md")).toBeUndefined();
  });

  it("keeps an empty text (everything deleted is still a draft)", async () => {
    const copy = await saved(service.save(1, "a.md", { baseBlob: "b", content: "" }, ALICE));
    expect(copy.content).toBe("");
    expect((await service.get(1, "a.md"))?.content).toBe("");
  });

  describe("a draft is of one version of the file", () => {
    it("refuses a save for another base, and says which base the draft is of, leaving it alone", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "old", content: "mine" }, ALICE));
      const result = await service.save(1, "a.md", { baseBlob: "new", content: "theirs" }, BOB);
      expect(result).toEqual({ ok: false, reason: "base_mismatch", baseBlob: "old" });
      expect(await service.get(1, "a.md")).toMatchObject({ baseBlob: "old", content: "mine", editors: [ALICE] });
    });
  });

  describe("two saves at once", () => {
    it("lose neither editor, and the later text is one of the two", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "b", content: "start" }, ALICE));
      const editors = Array.from({ length: 6 }, (_, i): Editor => ({ type: "account", id: `user-${i}` }));
      const results = await Promise.all(editors.map((editor, i) => service.save(1, "a.md", { baseBlob: "b", content: `by ${i}` }, editor)));
      expect(results.every((result) => result.ok)).toBe(true);
      const copy = await service.get(1, "a.md");
      expect(copy?.editors.map((editor) => editor.id).sort()).toEqual(["user-0", "user-1", "user-2", "user-3", "user-4", "user-5", "user-alice"]);
      expect(copy?.content).toMatch(/^by [0-5]$/);
    });

    it("start one draft, not two", async () => {
      const results = await Promise.all([ALICE, BOB].map((editor) => service.save(1, "new.md", { baseBlob: "b", content: editor.id }, editor)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await service.count(1)).toBe(1);
      expect((await service.get(1, "new.md"))?.editors).toHaveLength(2);
    });
  });

  describe("refuses what cannot be kept", () => {
    it.each([
      ["a NUL", "a\u0000b"],
      ["a lone surrogate", "a\ud800b"],
      ["a lone low surrogate", "\udc00"],
    ])("%s, and keeps nothing", async (_name, content) => {
      const result = await service.save(1, "a.md", { baseBlob: "b", content }, ALICE);
      expect(result).toMatchObject({ ok: false, reason: "unstorable" });
      expect(await service.count(1)).toBe(0);
    });

    it("does not touch an existing draft when the new text is refused", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "b", content: "good" }, ALICE));
      expect(await service.save(1, "a.md", { baseBlob: "b", content: "bad\u0000" }, BOB)).toMatchObject({ ok: false, reason: "unstorable" });
      expect(await service.get(1, "a.md")).toMatchObject({ content: "good", editors: [ALICE] });
    });

    it("text of exactly 1 MiB is kept, one byte more is not", async () => {
      expect(whyUnstorable("a".repeat(MAX_CONTENT_BYTES))).toBeUndefined();
      expect(whyUnstorable("a".repeat(MAX_CONTENT_BYTES + 1))).toMatch(/larger/);
      expect(whyUnstorable("é".repeat(MAX_CONTENT_BYTES / 2 + 1))).toMatch(/larger/);
      const copy = await saved(service.save(1, "big.md", { baseBlob: "b", content: "a".repeat(MAX_CONTENT_BYTES) }, ALICE));
      expect(copy.content).toHaveLength(MAX_CONTENT_BYTES);
    });

    it("a new draft past the limit for a connection, but still saves the ones it has", async () => {
      const values = Array.from({ length: MAX_DRAFTS_PER_CONNECTION }, (_, i) => sql`(${1}, ${`f${i}.md`}, ${"b"}, ${""}, ${"[]"}, ${clock}, ${clock})`);
      await dbRun(database, sql`INSERT INTO ${table()} (connection_id, path, base_blob, content, editors, created_at, last_edit) VALUES ${sql.join(values, sql`, `)}`);
      expect(await service.save(1, "one-more.md", { baseBlob: "b", content: "x" }, ALICE)).toEqual({ ok: false, reason: "too_many" });
      expect(await service.save(1, "f0.md", { baseBlob: "b", content: "x" }, ALICE)).toMatchObject({ ok: true });
      expect(await service.save(2, "one-more.md", { baseBlob: "b", content: "x" }, ALICE)).toMatchObject({ ok: true });
    });
  });

  describe("discarding", () => {
    it("removes the draft and says whether there was one", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "b", content: "x" }, ALICE));
      expect(await service.discard(1, "a.md")).toBe(true);
      expect(await service.get(1, "a.md")).toBeUndefined();
      expect(await service.discard(1, "a.md")).toBe(false);
    });

    it("only the one asked for", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "b", content: "x" }, ALICE));
      await saved(service.save(1, "b.md", { baseBlob: "b", content: "x" }, ALICE));
      await saved(service.save(2, "a.md", { baseBlob: "b", content: "x" }, ALICE));
      await service.discard(1, "a.md");
      expect(await service.count(1)).toBe(1);
      expect(await service.count(2)).toBe(1);
    });

    it("lets a file be started again from a new base", async () => {
      await saved(service.save(1, "a.md", { baseBlob: "old", content: "x" }, ALICE));
      await service.discard(1, "a.md");
      expect(await service.save(1, "a.md", { baseBlob: "new", content: "y" }, ALICE)).toMatchObject({ ok: true, workingCopy: { baseBlob: "new", editors: [ALICE] } });
    });
  });

  describe("moving a draft onto another version of the file", () => {
    const start = async () => {
      await saved(service.save(1, "a.md", { baseBlob: "old", content: "mine" }, ALICE));
      return (await service.get(1, "a.md"))!;
    };

    it("changes the base and the text, keeps when it was started, and adds who did it", async () => {
      const before = await start();
      clock += 5_000;
      const result = await service.rebase(1, "a.md", { fromBase: "old", toBase: "new", content: "merged", lastEdit: before.lastEdit }, BOB);
      expect(result).toEqual({ ok: true, workingCopy: { path: "a.md", baseBlob: "new", content: "merged", editors: [ALICE, BOB], createdAt: before.createdAt, lastEdit: clock } });
      expect(await service.get(1, "a.md")).toEqual((result as { workingCopy: WorkingCopy }).workingCopy);
    });

    it("does not list an editor twice", async () => {
      const before = await start();
      const result = await service.rebase(1, "a.md", { fromBase: "old", toBase: "new", content: "mine", lastEdit: before.lastEdit }, ALICE);
      expect((result as { workingCopy: WorkingCopy }).workingCopy.editors).toEqual([ALICE]);
    });

    it("is refused, changing nothing, if the draft is not the one that was looked at", async () => {
      const before = await start();
      const attempt = (over: Partial<{ fromBase: string; lastEdit: number }>, path = "a.md", connection = 1) =>
        service.rebase(connection, path, { fromBase: "old", toBase: "new", content: "merged", lastEdit: before.lastEdit, ...over }, ALICE);
      expect(await attempt({ fromBase: "other" })).toEqual({ ok: false, reason: "changed" });
      expect(await attempt({ lastEdit: before.lastEdit - 1 })).toEqual({ ok: false, reason: "changed" });
      expect(await attempt({}, "b.md")).toEqual({ ok: false, reason: "changed" });
      expect(await attempt({}, "a.md", 2)).toEqual({ ok: false, reason: "changed" });
      clock += 1;
      await saved(service.save(1, "a.md", { baseBlob: "old", content: "typed since" }, ALICE));
      expect(await attempt({})).toEqual({ ok: false, reason: "changed" });
      expect(await service.get(1, "a.md")).toMatchObject({ baseBlob: "old", content: "typed since" });
    });

    it("is refused for a text that cannot be kept, and the draft is left as it was", async () => {
      const before = await start();
      const result = await service.rebase(1, "a.md", { fromBase: "old", toBase: "new", content: "a\u0000b", lastEdit: before.lastEdit }, ALICE);
      expect(result).toMatchObject({ ok: false, reason: "unstorable" });
      expect(await service.get(1, "a.md")).toEqual(before);
    });

    it("only one of two moves at once wins", async () => {
      const before = await start();
      const results = await Promise.all([ALICE, BOB].map((editor, i) => service.rebase(1, "a.md", { fromBase: "old", toBase: `new${i}`, content: `c${i}`, lastEdit: before.lastEdit }, editor)));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });
  });

  it("forgets every draft of a connection and no other", async () => {
    await saved(service.save(1, "a.md", { baseBlob: "b", content: "x" }, ALICE));
    await saved(service.save(1, "b.md", { baseBlob: "b", content: "x" }, ALICE));
    await saved(service.save(2, "a.md", { baseBlob: "b", content: "x" }, ALICE));
    await service.forget(1);
    expect(await service.count(1)).toBe(0);
    expect(await service.count(2)).toBe(1);
    expect(await dbAll(database, sql`SELECT id FROM ${table()}`)).toHaveLength(1);
  });
});
