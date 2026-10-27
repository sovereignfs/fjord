import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { DocIndex, type IndexedFile } from "./doc-index";

/** Which Doc is at which path, over the real databases. */
const { leg } = testTarget();
let database: Database;
let index: DocIndex;
const table = () => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  index = new DocIndex(database, () => 1_800_000_000_000);
});
afterAll(async () => database.close());
beforeEach(async () => dbRun(database, sql`DELETE FROM ${table()}`));

const A = "01jagc4k7pt8y3wqnmzv5xrb8j";
const B = "01jagc4k7pt8y3wqnmzv5xrb9k";
const file = (path: string, docId: string | null, over: Partial<IndexedFile> = {}): IndexedFile => ({ path, docId, kind: "note", blob: "b".repeat(40), ...over });

describe(`the id index (${leg})`, () => {
  it("remembers what was read, with the blob, and says it by connection", async () => {
    await index.put(1, [file("Notes/a.md", A), file("Notes/b.fj.md", B, { kind: "document", blob: "c".repeat(40) }), file("Notes/plain.md", null)]);
    expect([...(await index.all(1)).values()]).toEqual(expect.arrayContaining([file("Notes/a.md", A), file("Notes/b.fj.md", B, { kind: "document", blob: "c".repeat(40) }), file("Notes/plain.md", null)]));
    expect((await index.all(1)).size).toBe(3);
    expect((await index.all(2)).size).toBe(0);
  });

  it("finds an id among the connections asked, and among no others", async () => {
    await index.put(1, [file("Notes/a.md", A)]);
    await index.put(2, [file("Other/copy.md", A)]);
    await index.put(3, [file("Notes/a.md", A)]);
    expect(await index.find([1, 2], A)).toEqual([
      { connectionId: 1, file: file("Notes/a.md", A) },
      { connectionId: 2, file: file("Other/copy.md", A) },
    ]);
    expect(await index.find([], A)).toEqual([]);
    expect(await index.find([1, 2], B)).toEqual([]);
  });

  it("replaces what was recorded for a path, and keeps one row per path", async () => {
    await index.put(1, [file("Notes/a.md", null)]);
    await index.put(1, [file("Notes/a.md", A, { kind: "document", blob: "d".repeat(40) })]);
    expect([...(await index.all(1)).values()]).toEqual([file("Notes/a.md", A, { kind: "document", blob: "d".repeat(40) })]);
  });

  it("keeps Unicode paths and a long list as they are, and forgets paths, and a connection", async () => {
    const files = Array.from({ length: 450 }, (_, i) => file(`Notes/日本語/ファイル ${i}.md`, i === 7 ? A : null));
    await index.put(1, files);
    expect((await index.all(1)).size).toBe(450);
    expect((await index.find([1], A))[0]?.file.path).toBe("Notes/日本語/ファイル 7.md");
    await index.remove(1, files.slice(0, 300).map((f) => f.path));
    expect((await index.all(1)).size).toBe(150);
    await index.put(2, [file("x.md", A)]);
    await index.forget(1);
    expect((await index.all(1)).size).toBe(0);
    expect((await index.all(2)).size).toBe(1);
  });
});
