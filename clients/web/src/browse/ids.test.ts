import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { DocIndex } from "./doc-index";
import { type Source, docIdOf, isDocId, plaintextDocs, recordRead, resolveDocId } from "./ids";
import { readRepository } from "./repository";
import { TreeCache } from "./tree-cache";

/**
 * Finding a file by its Doc id (ROADMAP 1b.6): over a host that counts what is read of it, the real format module, and the
 * real databases. What matters is the answer, and how little is read to give it: the index is believed only where the
 * repository still has the blob it was made from.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const OTHER: RepositoryRef = { owner: "acme", name: "more" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const ENCRYPTED_VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { mode: "none" }, fileNaming: "plain" });
const A = "01jagc4k7pt8y3wqnmzv5xrb8j";
const B = "01jagc4k7pt8y3wqnmzv5xrb9k";
const doc = (id: string, title = "T") => `---\nid: ${id}\ntitle: ${title}\n---\n\nbody\n`;

let database: Database;
let index: DocIndex;
const table = () => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const trees = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
  index = new DocIndex(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${table()}`);
  await dbRun(database, sql`DELETE FROM ${trees()}`);
});

function host(...repositories: [RepositoryRef, Record<string, string | null>][]): MemoryProvider {
  const memory = new MemoryProvider();
  for (const [ref, files] of repositories) {
    memory.createRepository(ref);
    memory.seed(ref, files);
  }
  return memory;
}

/** The repository as it is now, read the way a page reads it. */
async function sourceOf(memory: MemoryProvider, connectionId: number, ref: RepositoryRef = REF): Promise<Source> {
  const read = await readRepository({ provider: memory, cache: new TreeCache(database), format: fjord() }, { id: connectionId, ref, branch: "main" });
  return { connectionId, ref, read, provider: memory };
}

const deps = () => ({ index, format: fjord() });
const reads = (memory: MemoryProvider) => vi.spyOn(memory, "readBlob");

describe("an id", () => {
  it("is 26 lowercase Crockford characters that fit 128 bits, and nothing else", () => {
    expect(isDocId(A)).toBe(true);
    for (const bad of ["", A.toUpperCase(), A.slice(1), `${A}0`, "81jagc4k7pt8y3wqnmzv5xrb8j", "01jagc4k7pt8y3wqnmzv5xrb8i", "01jagc4k7pt8y3wqnmzv5xrb8l", "../etc/passwd", `${A}%00`]) expect(isDocId(bad)).toBe(false);
  });
});

describe.skipIf(!available)(`finding a file by its id (${leg})`, () => {
  it("finds a document and a note by what their headers say, and a file with no header is nothing", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/Plan.fj.md": doc(A), "Notes/b.md": doc(B), "Notes/plain.md": "# no header\n" }]);
    const source = await sourceOf(memory, 1);
    expect(await resolveDocId(deps(), [source], A)).toEqual({ matches: [{ connectionId: 1, path: "Notes/Plan.fj.md", kind: "document" }], incomplete: false });
    expect(await resolveDocId(deps(), [source], B)).toEqual({ matches: [{ connectionId: 1, path: "Notes/b.md", kind: "note" }], incomplete: false });
    expect((await resolveDocId(deps(), [source], "01jagc4k7pt8y3wqnmzv5xrbzz")).matches).toEqual([]);
  });

  it("reads a file once: what it said, and that it said nothing, are remembered while its blob is the same", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A), "Notes/b.md": doc(B), "Notes/plain.md": "# no header\n" }]);
    const spy = reads(memory);
    const source = await sourceOf(memory, 1);
    const manifestReads = spy.mock.calls.length; // the vault manifest, read to draw the repository
    await resolveDocId(deps(), [source], A);
    expect(spy.mock.calls.length - manifestReads).toBe(3);
    await resolveDocId(deps(), [source], B);
    await resolveDocId(deps(), [source], A);
    await resolveDocId(deps(), [source], "01jagc4k7pt8y3wqnmzv5xrbzz");
    expect(spy.mock.calls.length - manifestReads).toBe(3);
  });

  it("is not told by the index where a file is not: one edited since is read again, and a file whose id is gone is gone", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A) }]);
    await resolveDocId(deps(), [await sourceOf(memory, 1)], A);
    memory.seed(REF, { "Notes/a.md": "# the header was deleted elsewhere\n" });
    expect((await resolveDocId(deps(), [await sourceOf(memory, 1)], A)).matches).toEqual([]);
  });

  it("finds a file that was moved, and forgets where it was; one deleted is not found", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A), "Notes/b.md": doc(B) }]);
    await resolveDocId(deps(), [await sourceOf(memory, 1)], A);
    await resolveDocId(deps(), [await sourceOf(memory, 1)], B);
    memory.seed(REF, { "Notes/a.md": null, "Notes/Moved/a.md": doc(A), "Notes/b.md": null });

    const source = await sourceOf(memory, 1);
    expect((await resolveDocId(deps(), [source], A)).matches).toEqual([{ connectionId: 1, path: "Notes/Moved/a.md", kind: "note" }]);
    expect((await resolveDocId(deps(), [source], B)).matches).toEqual([]);
    expect([...(await index.all(1)).keys()].sort()).toEqual(["Notes/Moved/a.md"]);
  });

  it("finds a file that changed and still has the id, without searching for it", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A), "Notes/other.md": doc(B) }]);
    await resolveDocId(deps(), [await sourceOf(memory, 1)], A);
    memory.seed(REF, { "Notes/a.md": doc(A, "Edited"), "Notes/other.md": doc(B, "Edited too") });
    const spy = reads(memory);
    const source = await sourceOf(memory, 1);
    const before = spy.mock.calls.length;
    expect((await resolveDocId(deps(), [source], A)).matches).toHaveLength(1);
    expect(spy.mock.calls.length - before).toBe(1); // the one file the index named, not the other
  });

  it("says every place an id is, within a repository and across them, and in no repository it was not asked of", async () => {
    const memory = host(
      [REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A), "Notes/copy of a.md": doc(A) }],
      [OTHER, { "Notes/fjord.vault.json": VAULT, "Notes/a.fj.md": doc(A) }],
    );
    const both = [await sourceOf(memory, 1), await sourceOf(memory, 2, OTHER)];
    const found = await resolveDocId(deps(), both, A);
    expect(found.matches).toEqual([
      { connectionId: 1, path: "Notes/a.md", kind: "note" },
      { connectionId: 1, path: "Notes/copy of a.md", kind: "note" },
      { connectionId: 2, path: "Notes/a.fj.md", kind: "document" },
    ]);
    expect((await resolveDocId(deps(), [both[0]!], A)).matches.map((m) => m.connectionId)).toEqual([1, 1]);
  });

  it("never reads an encrypted vault, or a file that is not a note or a document", async () => {
    const memory = host([REF, { "Secret/fjord.vault.json": ENCRYPTED_VAULT, "Secret/a.md.age": "payload", "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A), "Notes/image.png": "x", "stray.md": doc(B), ".fjord/x.md": doc(B) }]);
    const spy = reads(memory);
    const source = await sourceOf(memory, 1);
    const before = spy.mock.calls.length;
    expect([...plaintextDocs(source.read).keys()]).toEqual(["Notes/a.md"]);
    expect((await resolveDocId(deps(), [source], B)).matches).toEqual([]);
    expect(spy.mock.calls.length - before).toBe(1);
  });

  it("searches a share at a time and says when it stopped, then goes on from there", async () => {
    const files: Record<string, string> = { "Notes/fjord.vault.json": VAULT };
    for (let i = 0; i < 10; i++) files[`Notes/n${String(i).padStart(2, "0")}.md`] = doc(i === 9 ? A : `01jagc4k7pt8y3wqnmzv5xrb${String(i).padStart(2, "0")}`);
    const memory = host([REF, files]);
    const source = await sourceOf(memory, 1);
    expect(await resolveDocId(deps(), [source], A, 4)).toEqual({ matches: [], incomplete: true });
    expect(await resolveDocId(deps(), [source], A, 4)).toEqual({ matches: [], incomplete: true });
    expect((await resolveDocId(deps(), [source], A, 4)).matches).toEqual([{ connectionId: 1, path: "Notes/n09.md", kind: "note" }]);
  });

  it("does not search a repository too large to list, and does not forget what it knew of it", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A) }]);
    await resolveDocId(deps(), [await sourceOf(memory, 1)], A);
    memory.setTreeLimit(1);
    await dbRun(database, sql`DELETE FROM ${trees()}`); // the whole tree of this commit was kept
    const cut = await sourceOf(memory, 1);
    expect(cut.read.partial).toBe(true);
    expect(await resolveDocId(deps(), [cut], B)).toEqual({ matches: [], incomplete: false });
    expect((await index.all(1)).size).toBe(1);
  });

  it("notes what a page read, so that nothing is read again for it", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/a.md": doc(A) }]);
    const source = await sourceOf(memory, 1);
    const file = source.read.discovery.vaults[0]!.files[0]!;
    await recordRead(index, fjord(), 1, file, source.read.blobs.get(file.path)!, doc(A));
    const spy = reads(memory);
    expect((await resolveDocId(deps(), [source], A)).matches).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    expect(docIdOf(fjord(), "---\nid: nope\n---\n")).toBeNull();
  });

  it("treats a file that is not text, or too large, as one with no id", async () => {
    const memory = host([REF, { "Notes/fjord.vault.json": VAULT, "Notes/bad.md": "ÿ", "Notes/a.md": doc(A) }]);
    memory.seed(REF, { "Notes/big.md": "x".repeat(1024 * 1024 + 1) });
    memory.seed(REF, { "Notes/binary.md": new Uint8Array([0xff, 0xfe, 0x00]) as unknown as string });
    const source = await sourceOf(memory, 1);
    expect((await resolveDocId(deps(), [source], A)).matches).toHaveLength(1);
    expect((await index.all(1)).get("Notes/big.md")?.docId).toBeNull();
    expect((await index.all(1)).get("Notes/binary.md")?.docId).toBeNull();
  });
});
