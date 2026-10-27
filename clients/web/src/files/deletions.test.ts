import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { DeletionService, MAX_LISTED } from "./deletions";

/** What was deleted, kept so that it can be put back, over the real databases. */
const { leg } = testTarget();
const DAY = 24 * 60 * 60 * 1000;
let database: Database;
let service: DeletionService;
let clock = 1_800_000_000_000;
const table = () => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  service = new DeletionService(database, { now: () => clock });
});
afterAll(async () => database.close());
beforeEach(async () => {
  clock = 1_800_000_000_000;
  await dbRun(database, sql`DELETE FROM ${table()}`);
});

const entry = (path: string, over: Partial<Parameters<DeletionService["record"]>[3][number]> = {}) => ({ path, kind: "note" as const, blob: "b".repeat(40), ...over });

describe(`deletions (${leg})`, () => {
  it("remembers what was deleted, by which commit and whom, and when", async () => {
    const ids = await service.record(1, "c".repeat(40), "alice", [entry("Notes/a.md", { docId: "01jagc4k7pt8y3wqnmzv5xrb8j", kind: "document", blob: "a".repeat(40) }), entry("Notes/b.md")]);
    expect(ids).toHaveLength(2);
    expect(await service.get(1, ids)).toEqual([
      { id: ids[0], path: "Notes/a.md", docId: "01jagc4k7pt8y3wqnmzv5xrb8j", kind: "document", blob: "a".repeat(40), deletingCommit: "c".repeat(40), deletedBy: "alice", deletedAt: clock, restoredAt: null },
      { id: ids[1], path: "Notes/b.md", docId: null, kind: "note", blob: "b".repeat(40), deletingCommit: "c".repeat(40), deletedBy: "alice", deletedAt: clock, restoredAt: null },
    ]);
  });

  it("keeps a file's Unicode name and a long list of files as they are", async () => {
    const entries = Array.from({ length: 450 }, (_, i) => entry(`Notes/日本語/ファイル ${i}.md`));
    const ids = await service.record(1, "c".repeat(40), "alice", entries);
    expect(ids).toHaveLength(450);
    const back = await service.get(1, ids);
    expect(back.map((record) => record.path)).toEqual(entries.map((e) => e.path));
  });

  it("lists the newest first, only what is not put back, and only within the window", async () => {
    const [old] = await service.record(1, "1".repeat(40), "alice", [entry("Notes/old.md")]);
    clock += 20 * DAY;
    const [mid] = await service.record(1, "2".repeat(40), "alice", [entry("Notes/mid.md")]);
    clock += 15 * DAY; // old is now 35 days ago, mid 15
    const [fresh] = await service.record(1, "3".repeat(40), "alice", [entry("Notes/fresh.md")]);
    expect((await service.list(1, 30 * DAY)).map((record) => record.id)).toEqual([fresh, mid]);
    expect((await service.list(1, 40 * DAY)).map((record) => record.id)).toEqual([fresh, mid, old]);
    await service.markRestored(1, [mid!]);
    expect((await service.list(1, 30 * DAY)).map((record) => record.id)).toEqual([fresh]);
  });

  it("lists the files of one deletion together, in order", async () => {
    await service.record(1, "1".repeat(40), "alice", [entry("Notes/f/a.md"), entry("Notes/f/b.md"), entry("Notes/f/c.md")]);
    clock += 1000;
    await service.record(1, "2".repeat(40), "alice", [entry("Notes/z.md")]);
    expect((await service.list(1, DAY)).map((record) => record.path)).toEqual(["Notes/z.md", "Notes/f/a.md", "Notes/f/b.md", "Notes/f/c.md"]);
  });

  it("lists no more than it should", async () => {
    await service.record(1, "c".repeat(40), "alice", Array.from({ length: MAX_LISTED + 5 }, (_, i) => entry(`Notes/${i}.md`)));
    expect(await service.list(1, DAY)).toHaveLength(MAX_LISTED);
  });

  it("keeps connections apart: another's records are neither listed, found, nor marked", async () => {
    const [mine] = await service.record(1, "c".repeat(40), "alice", [entry("Notes/a.md")]);
    const [theirs] = await service.record(2, "c".repeat(40), "bob", [entry("Notes/a.md")]);
    expect((await service.list(1, DAY)).map((record) => record.id)).toEqual([mine]);
    expect(await service.get(1, [theirs!])).toEqual([]);
    expect(await service.markRestored(1, [theirs!])).toEqual([]);
    expect((await service.get(2, [theirs!]))[0]!.restoredAt).toBeNull();
  });

  it("marks a deletion put back once, and says which it did", async () => {
    const ids = await service.record(1, "c".repeat(40), "alice", [entry("Notes/a.md"), entry("Notes/b.md")]);
    clock += 5000;
    expect(await service.markRestored(1, [ids[0]!])).toEqual([ids[0]]);
    expect(await service.markRestored(1, ids)).toEqual([ids[1]]); // the first was already
    expect((await service.get(1, ids)).map((record) => record.restoredAt)).toEqual([clock, clock]);
    expect(await service.markRestored(1, [])).toEqual([]);
  });

  it("forgets one connection's records and no other's", async () => {
    await service.record(1, "c".repeat(40), "alice", [entry("Notes/a.md")]);
    await service.record(2, "c".repeat(40), "bob", [entry("Notes/a.md")]);
    await service.forget(1);
    expect(await service.list(1, DAY)).toEqual([]);
    expect(await service.list(2, DAY)).toHaveLength(1);
  });

  it("records nothing, and finds nothing, for an empty list", async () => {
    expect(await service.record(1, "c".repeat(40), "alice", [])).toEqual([]);
    expect(await service.get(1, [])).toEqual([]);
  });
});
