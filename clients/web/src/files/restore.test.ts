import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity, Provider } from "../providers/types";
import { WorkingCopyService } from "../working/service";
import { type DeleteTarget, deletePath } from "./delete";
import { DeletionService } from "./deletions";
import { type RestoreDeps, restoreDeleted } from "./restore";

/**
 * Putting back what was deleted (ROADMAP 1b.12) against a GitHub whose storage is a real git repository. The round trip is
 * the point: delete through the app, restore through the app, and the bytes are the ones that went. And the rule that it is
 * never over anything. Needs the format module built.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const { leg } = testTarget();
const DAY = 24 * 60 * 60 * 1000;
let database: Database;
let deletions: DeletionService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
let clock = 1_800_000_000_000;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const deletionTable = () => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);

beforeAll(async () => {
  if (!available) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  deletions = new DeletionService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  if (!available) return;
  clock = 1_800_000_000_000;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${deletionTable()}`);
});
afterEach(async () => h?.close());

const seed = (files: Record<string, string> = {}) => h.seed({ "Notes/fjord.vault.json": VAULT, ...files });
const kindOf = (path: string) => (path.endsWith(".fj.md") ? "document" : path.endsWith(".md") ? "note" : "other");
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
/** Delete through the app, so that there is a record to put back. */
async function remove(target: DeleteTarget): Promise<number[]> {
  const result = await deletePath(
    { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), deletions, drafts: new WorkingCopyService(database), saveDraft: async () => ({ ok: false, reason: "unavailable" }) },
    { connectionId: 1, accountId: "ada", vault: "Notes", target, kindOf, author: ADA },
  );
  if (!result.ok) throw new Error(`could not delete: ${result.reason}`);
  return result.deletions;
}
const removeFile = async (path: string) => remove({ type: "file", path, blob: await blobOf(path) });
const deps = (over: Partial<RestoreDeps> = {}, provider: Provider = h.provider): RestoreDeps => ({
  provider,
  ref: h.repo,
  branch: "main",
  format: fjord(),
  deletions,
  vaultOk: (vault) => vault === "Notes",
  windowMs: 30 * DAY,
  now: () => clock,
  ...over,
});
const restore = (ids: number[], path?: string, over: Partial<RestoreDeps> = {}, provider?: Provider) =>
  restoreDeleted(deps(over, provider), { connectionId: 1, ids, path, author: ADA });

describe.skipIf(!available)(`putting back a file (${leg})`, () => {
  it("is one commit that adds the exact bytes back at the path it had, and the deletion is then put back", async () => {
    const text = "﻿# Weekly\r\n\r\ntrailing  \r\n日本語 💧";
    await seed({ "Notes/Weekly review.md": text, "Notes/other.md": "o" });
    const [id] = await removeFile("Notes/Weekly review.md");
    const afterDelete = (await fake.branchHead()) as string;

    const result = await restore([id!]);
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), paths: ["Notes/Weekly review.md"] });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(afterDelete);
    expect((await fake.filesAt(commit))["Notes/Weekly review.md"]).toBe(text);
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Restore Weekly review");
    expect((await deletions.get(1, [id!]))[0]!.restoredAt).toBe(clock);
    expect(await deletions.list(1, 30 * DAY)).toEqual([]);
    await fake.fsck();
  });

  it("is not done twice", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    expect(await restore([id!])).toMatchObject({ ok: true });
    const head = await fake.branchHead();
    expect(await restore([id!])).toEqual({ ok: false, reason: "already_restored" });
    expect(await fake.branchHead()).toBe(head);
  });

  it("is not offered after the restore window, and git has the file still", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    clock += 31 * DAY;
    const head = await fake.branchHead();
    expect(await restore([id!])).toEqual({ ok: false, reason: "expired" });
    expect(await restore([id!], undefined, { windowMs: 60 * DAY })).toMatchObject({ ok: true });
    expect(await fake.branchHead()).not.toBe(head);
  });

  it("knows only the connection's own deletions", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    const head = await fake.branchHead();
    expect(await restoreDeleted(deps(), { connectionId: 2, ids: [id!], author: ADA })).toEqual({ ok: false, reason: "not_found" });
    expect(await restore([id! + 1000])).toEqual({ ok: false, reason: "not_found" });
    expect(await restore([])).toEqual({ ok: false, reason: "not_found" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)(`putting back a folder (${leg})`, () => {
  it("puts every file back where it was, in one commit", async () => {
    const files = { "Notes/Projects/a.md": "a", "Notes/Projects/2026/b.md": "b", "Notes/Projects/2026/c.csv": "x,y" };
    await seed({ ...files, "Notes/keep.md": "k" });
    const ids = await remove({ type: "folder", path: "Notes/Projects", files: 3 });
    const afterDelete = (await fake.branchHead()) as string;

    const result = await restore(ids);
    expect(result).toMatchObject({ ok: true });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(afterDelete);
    expect(await fake.filesAt(commit)).toEqual({ ...files, "Notes/fjord.vault.json": VAULT, "Notes/keep.md": "k" });
    expect((await fake.show(commit, "%B")).split("\n")[0]).toBe("Restore 3 files");
    expect(await deletions.list(1, 30 * DAY)).toEqual([]);
  });

  it("is all or nothing: if any of its paths is taken, none is put back, and the taken are named", async () => {
    await seed({ "Notes/Projects/a.md": "a", "Notes/Projects/b.md": "b" });
    const ids = await remove({ type: "folder", path: "Notes/Projects", files: 2 });
    const theirs = await fake.commitFiles({ "Notes/Projects/b.md": "a new b" });
    expect(await restore(ids)).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/Projects/b.md"] });
    expect(await fake.branchHead()).toBe(theirs);
    expect((await fake.filesAt(theirs))["Notes/Projects/b.md"]).toBe("a new b");
    expect(await deletions.list(1, 30 * DAY)).toHaveLength(2);
  });

  it("is refused for two files that differ only by case, which a case-insensitive filesystem would merge", async () => {
    await seed({ "Notes/F/A.md": "a", "Notes/F/b.md": "b" });
    const blobs = { a: await blobOf("Notes/F/A.md"), b: await blobOf("Notes/F/b.md") };
    const ids = await deletions.record(1, "c".repeat(40), "ada", [
      { path: "Notes/F/Same.md", kind: "note", blob: blobs.a },
      { path: "Notes/F/same.md", kind: "note", blob: blobs.b },
    ]);
    const head = await fake.branchHead();
    expect(await restore(ids)).toEqual({ ok: false, reason: "bad_path" });
    expect(await fake.branchHead()).toBe(head);
  });

  it("does not put two files at one path", async () => {
    await seed({ "Notes/F/A.md": "a" });
    const blob = await blobOf("Notes/F/A.md");
    const ids = await deletions.record(1, "c".repeat(40), "ada", [
      { path: "Notes/F/Same.md", kind: "note", blob },
      { path: "Notes/F/Same.md", kind: "note", blob },
    ]);
    expect(await restore(ids)).toEqual({ ok: false, reason: "bad_path" });
  });

  it("does not take a path for a single file's chosen one", async () => {
    await seed({ "Notes/Projects/a.md": "a", "Notes/Projects/b.md": "b" });
    const ids = await remove({ type: "folder", path: "Notes/Projects", files: 2 });
    expect(await restore(ids, "Notes/Elsewhere/a.md")).toEqual({ ok: false, reason: "bad_path" });
  });
});

describe.skipIf(!available)(`never over anything (${leg})`, () => {
  it("is refused when something is at the path, and what is there is untouched", async () => {
    await seed({ "Notes/n.md": "the deleted one" });
    const [id] = await removeFile("Notes/n.md");
    const theirs = await fake.commitFiles({ "Notes/n.md": "made since" });
    expect(await restore([id!])).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/n.md"] });
    expect(await fake.branchHead()).toBe(theirs);
    expect((await fake.filesAt(theirs))["Notes/n.md"]).toBe("made since");
  });

  it("is refused when a name that differs only by case is there", async () => {
    await seed({ "Notes/Plan.md": "p" });
    const [id] = await removeFile("Notes/Plan.md");
    await fake.commitFiles({ "Notes/PLAN.md": "other" });
    expect(await restore([id!])).toMatchObject({ ok: false, reason: "path_taken" });
  });

  it("is refused when a folder is at the path, or a file is where one of its folders must go", async () => {
    await seed({ "Notes/n.md": "x", "Notes/Sub/inner.md": "i" });
    const [a] = await removeFile("Notes/n.md");
    await fake.commitFiles({ "Notes/n.md/child.md": "now a folder" });
    expect(await restore([a!])).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/n.md"] });

    const [b] = await removeFile("Notes/Sub/inner.md"); // the folder goes with its last file
    await fake.commitFiles({ "Notes/Sub": "now a file" });
    expect(await restore([b!])).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/Sub/inner.md"] });
  });

  it("is refused when a folder on the way differs only by case from one that is there", async () => {
    await seed({ "Notes/Archive/old.md": "o" });
    const [id] = await removeFile("Notes/Archive/old.md");
    await fake.commitFiles({ "Notes/ARCHIVE/new.md": "n" });
    expect(await restore([id!])).toMatchObject({ ok: false, reason: "path_taken" });
  });

  it("makes the folders it needs, when they are gone", async () => {
    await seed({ "Notes/A/B/deep.md": "d" });
    const [id] = await removeFile("Notes/A/B/deep.md");
    expect(await restore([id!])).toMatchObject({ ok: true, paths: ["Notes/A/B/deep.md"] });
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/A/B/deep.md"]).toBe("d");
  });
});

describe.skipIf(!available)(`somewhere else (${leg})`, () => {
  it("puts a single file at the path chosen, making its folders, and the same bytes", async () => {
    await seed({ "Notes/n.md": "bytes\r\n" });
    const [id] = await removeFile("Notes/n.md");
    expect(await restore([id!], "Notes/Archive/2026/Old note.md")).toMatchObject({ ok: true, paths: ["Notes/Archive/2026/Old note.md"] });
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/Archive/2026/Old note.md"]).toBe("bytes\r\n");
  });

  it("keeps what the file is: a document stays a document and a note a note", async () => {
    await seed({ "Notes/d.fj.md": "d", "Notes/n.md": "n" });
    const [doc] = await removeFile("Notes/d.fj.md");
    const [note] = await removeFile("Notes/n.md");
    expect(await restore([doc!], "Notes/d.md")).toEqual({ ok: false, reason: "bad_path" });
    expect(await restore([note!], "Notes/n.fj.md")).toEqual({ ok: false, reason: "bad_path" });
    expect(await restore([note!], "Notes/n.txt")).toEqual({ ok: false, reason: "bad_path" });
    expect(await restore([doc!], "Notes/Q4.FJ.MD")).toMatchObject({ ok: true });
  });

  it.each(["n.md", "", "Notes/a:b.md", "Notes/CON.md", "Notes/ trailing /x.md", "Notes//x.md", "Notes/x.md ", "Notes/../x.md", "Notes/./x.md", "Notes/.git/x.md", "/Notes/x.md"])("refuses the path %j as a name fjord-core would not accept", async (path) => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    const head = await fake.branchHead();
    expect(await restore([id!], path)).toEqual({ ok: false, reason: "bad_path" });
    expect(await fake.branchHead()).toBe(head);
  });

  it("is refused into a vault that cannot be written to", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    const head = await fake.branchHead();
    expect(await restore([id!], "Secret/n.md")).toEqual({ ok: false, reason: "vault_unavailable" });
    expect(await restore([id!], undefined, { vaultOk: () => false })).toEqual({ ok: false, reason: "vault_unavailable" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)(`when others are writing too, and when it goes wrong (${leg})`, () => {
  it("goes on top of a head that moved without touching the path, once", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    let theirs = "";
    fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs = await fake.commitFiles({ "Notes/other.md": "o" })), "PATCH");
    const result = (await restore([id!])) as { commit: string };
    expect(await fake.show(result.commit, "%P")).toBe(theirs);
    expect(await fake.filesAt(result.commit)).toMatchObject({ "Notes/n.md": "x", "Notes/other.md": "o" });
  });

  it("is refused, not overwritten, when someone makes the path as it is being restored", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    let theirs = "";
    fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs = await fake.commitFiles({ "Notes/n.md": "theirs" })), "PATCH");
    expect(await restore([id!])).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/n.md"] });
    expect(await fake.branchHead()).toBe(theirs);
  });

  it("gives up, without forcing, when the head keeps moving", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    let n = 0;
    for (let i = 0; i < 2; i++) fake.before(/\/git\/refs\/heads\/main$/, async () => void (await fake.commitFiles({ [`Notes/race ${++n}.md`]: "r" })), "PATCH");
    expect(await restore([id!])).toEqual({ ok: false, reason: "head_moved" });
    expect(fake.requests.filter((r) => r.method === "PATCH").every((r) => (r.body as { force?: boolean }).force === false)).toBe(true);
    expect((await deletions.list(1, 30 * DAY)).map((record) => record.id)).toEqual([id]);
  });

  it("says so, and leaves the deletion as it was, when the token cannot write, was revoked, or the host is down", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    const head = await fake.branchHead();
    expect(await restore([id!], undefined, {}, h.readOnly!())).toEqual({ ok: false, reason: "read_only" });
    expect(await restore([id!], undefined, {}, h.revoked!())).toEqual({ ok: false, reason: "bad_token" });
    fake.fail(/.*/, { status: 503, body: { message: "down" }, times: 20 });
    expect(await restore([id!])).toEqual({ ok: false, reason: "unavailable" });
    expect(await fake.branchHead()).toBe(head);
    expect(await deletions.list(1, 30 * DAY)).toHaveLength(1);
  });

  it("says when git no longer has the file, and writes nothing", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await deletions.record(1, "c".repeat(40), "ada", [{ path: "Notes/gone.md", kind: "note", blob: "e".repeat(40) }]);
    const head = await fake.branchHead();
    expect(await restore([id!])).toEqual({ ok: false, reason: "blob_gone" });
    expect(await fake.branchHead()).toBe(head);
  });

  it("is a restore all the same if it cannot be recorded", async () => {
    await seed({ "Notes/n.md": "x" });
    const [id] = await removeFile("Notes/n.md");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await restore([id!], undefined, { deletions: { get: deletions.get.bind(deletions), markRestored: async () => Promise.reject(new Error("db down")) } });
    expect(result).toMatchObject({ ok: true });
    logged.mockRestore();
  });
});
