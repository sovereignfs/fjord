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
import type { VersionResult } from "../working/version";
import { type DeleteDeps, type DeleteTarget, deletePath, deletedName } from "./delete";
import { DeletionService } from "./deletions";

/**
 * Deleting (ROADMAP 1b.12) against a GitHub whose storage is a real git repository: what git says about the commit is what is
 * asserted. Records and drafts are on the real databases. Needs the format module built, as `create.test.ts` does.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const { leg } = testTarget();
let database: Database;
let deletions: DeletionService;
let drafts: WorkingCopyService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
let clock = 1_800_000_000_000;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const DOC = (id: string, title: string) => `---\nid: ${id}\ntitle: ${title}\ncreated: 2026-10-16T09:34:00Z\n---\n\n# ${title}\n`;
const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";
const deletionTable = () => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);
const draftTable = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);

beforeAll(async () => {
  if (!available) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  deletions = new DeletionService(database, { now: () => clock });
  drafts = new WorkingCopyService(database, { now: () => clock });
});
afterAll(async () => database?.close());
beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${deletionTable()}`);
  await dbRun(database, sql`DELETE FROM ${draftTable()}`);
});
afterEach(async () => h?.close());

const noVersion = async (): Promise<VersionResult> => ({ ok: false, reason: "unavailable" });
const deps = (over: Partial<DeleteDeps> = {}, provider: Provider = h.provider): DeleteDeps => ({
  provider,
  ref: h.repo,
  branch: "main",
  format: fjord(),
  deletions,
  drafts,
  saveDraft: noVersion,
  ...over,
});
const kindOf = (path: string) => (path.endsWith(".fj.md") ? "document" : path.endsWith(".md") ? "note" : "other");
const seed = (files: Record<string, string> = {}) => h.seed({ "Notes/fjord.vault.json": VAULT, ...files });
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
const file = async (path: string): Promise<DeleteTarget> => ({ type: "file", path, blob: await blobOf(path) });
const run = (target: DeleteTarget, over: Partial<DeleteDeps> = {}, provider?: Provider) =>
  deletePath(deps(over, provider), { connectionId: 1, accountId: "ada", vault: "Notes", target, kindOf, author: ADA });

describe.skipIf(!available)(`deleting a file (${leg})`, () => {
  it("is one commit that removes that file and nothing else, by the person, and the file is recorded with its blob", async () => {
    const before = await seed({ "Notes/Weekly review.md": "# Weekly\n", "Notes/other.md": "o" });
    const blob = await blobOf("Notes/Weekly review.md");
    const result = await run({ type: "file", path: "Notes/Weekly review.md", blob });
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), files: 1, deletions: [expect.any(Number)] });
    const commit = (result as { commit: string }).commit;
    expect(await fake.branchHead()).toBe(commit);
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(Object.keys(await fake.filesAt(commit)).sort()).toEqual(["Notes/fjord.vault.json", "Notes/other.md"]);
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Delete Weekly review");
    expect(await deletions.get(1, (result as { deletions: number[] }).deletions)).toEqual([
      { id: expect.any(Number), path: "Notes/Weekly review.md", docId: null, kind: "note", blob, deletingCommit: commit, deletedBy: "ada", deletedAt: clock, restoredAt: null },
    ]);
    await fake.fsck();
  });

  it("records a document's identifier, and none for a note without a header or a file that is not one", async () => {
    await seed({ "Notes/doc.fj.md": DOC(ID, "Doc"), "Notes/plain.md": "# no header\n", "Notes/pic.png": "png" });
    const ids: number[] = [];
    for (const path of ["Notes/doc.fj.md", "Notes/plain.md", "Notes/pic.png"]) {
      const result = (await run(await file(path))) as { deletions: number[] };
      ids.push(...result.deletions);
    }
    expect((await deletions.get(1, ids)).map((record) => [record.path, record.kind, record.docId])).toEqual([
      ["Notes/doc.fj.md", "document", ID],
      ["Notes/plain.md", "note", null],
      ["Notes/pic.png", "other", null],
    ]);
  });

  it("writes nothing when the file is not the one the person saw", async () => {
    await seed({ "Notes/n.md": "mine\n" });
    const target = await file("Notes/n.md");
    const theirs = await fake.commitFiles({ "Notes/n.md": "changed elsewhere\n" });
    expect(await run(target)).toEqual({ ok: false, reason: "upstream_changed" });
    expect(await fake.branchHead()).toBe(theirs);
    expect(await deletions.list(1, 1e12)).toEqual([]);
  });

  it("writes nothing when the file is already gone, or is a folder now", async () => {
    await seed({ "Notes/n.md": "x\n", "Notes/d/inner.md": "i" });
    const target = await file("Notes/n.md");
    await fake.commitFiles({ "Notes/n.md": null });
    expect(await run(target)).toEqual({ ok: false, reason: "gone" });
    expect(await run({ type: "file", path: "Notes/d", blob: "a".repeat(40) })).toEqual({ ok: false, reason: "gone" });
  });

  it("is not for a vault, its manifest, or anything outside it", async () => {
    const head = await seed({ "Notes/n.md": "x" });
    expect(await run({ type: "folder", path: "Notes", files: 2 })).toEqual({ ok: false, reason: "protected" });
    expect(await run({ type: "file", path: "Notes/", blob: "a".repeat(40) })).toEqual({ ok: false, reason: "protected" });
    expect(await run(await file("Notes/fjord.vault.json"))).toEqual({ ok: false, reason: "protected" });
    expect(await run({ type: "file", path: "Other/n.md", blob: "a".repeat(40) })).toEqual({ ok: false, reason: "protected" });
    expect(await run({ type: "file", path: "Notes2/n.md", blob: "a".repeat(40) })).toEqual({ ok: false, reason: "protected" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)(`deleting a folder (${leg})`, () => {
  const FILES = { "Notes/Projects/a.md": "a", "Notes/Projects/b.fj.md": DOC(ID, "B"), "Notes/Projects/2026/c.csv": "x,y", "Notes/keep.md": "k", "Notes/Projects2/z.md": "z" };

  it("is one commit that removes everything in it and nothing beside it, and each file is recorded", async () => {
    const before = await seed(FILES);
    const result = await run({ type: "folder", path: "Notes/Projects", files: 3 });
    expect(result).toMatchObject({ ok: true, files: 3 });
    const { commit, deletions: ids } = result as { commit: string; deletions: number[] };
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(Object.keys(await fake.filesAt(commit)).sort()).toEqual(["Notes/Projects2/z.md", "Notes/fjord.vault.json", "Notes/keep.md"]);
    expect(await fake.show(commit, "%B")).toBe("Delete Projects\n\nRemoves 3 files.");
    const records = await deletions.get(1, ids);
    expect(records.map((record) => [record.path, record.kind, record.docId]).sort()).toEqual([
      ["Notes/Projects/2026/c.csv", "other", null],
      ["Notes/Projects/a.md", "note", null],
      ["Notes/Projects/b.fj.md", "document", null],
    ]);
    expect(new Set(records.map((record) => record.deletingCommit))).toEqual(new Set([commit]));
    await fake.fsck();
  });

  it("works when the host cut the tree listing short", async () => {
    await seed(FILES);
    fake.treeLimit = 2;
    expect(await run({ type: "folder", path: "Notes/Projects", files: 3 })).toMatchObject({ ok: true, files: 3 });
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!)).sort()).toEqual(["Notes/Projects2/z.md", "Notes/fjord.vault.json", "Notes/keep.md"]);
  });

  it("writes nothing when it no longer holds what the person was told, and says how many it holds", async () => {
    await seed(FILES);
    const theirs = await fake.commitFiles({ "Notes/Projects/new.md": "n" });
    expect(await run({ type: "folder", path: "Notes/Projects", files: 3 })).toEqual({ ok: false, reason: "folder_changed", detail: 4 });
    expect(await fake.branchHead()).toBe(theirs);
  });

  it("writes nothing for a folder that is not there, or that is too large", async () => {
    await seed(FILES);
    expect(await run({ type: "folder", path: "Notes/Nowhere", files: 1 })).toEqual({ ok: false, reason: "gone" });
    expect(await run({ type: "folder", path: "Notes/Projects", files: 3 }, { maxFiles: 2 })).toEqual({ ok: false, reason: "too_many" });
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!))).toHaveLength(Object.keys(FILES).length + 1);
  });

  it("is refused when something in it has a draft, and says how many, and writes nothing", async () => {
    const head = await seed(FILES);
    await drafts.save(1, "Notes/Projects/a.md", { baseBlob: await blobOf("Notes/Projects/a.md"), content: "unsaved" }, { type: "account", id: "ada" });
    await drafts.save(1, "Notes/Projects/2026/c.csv", { baseBlob: "x", content: "unsaved" }, { type: "account", id: "ada" });
    await drafts.save(1, "Notes/keep.md", { baseBlob: "x", content: "elsewhere" }, { type: "account", id: "ada" });
    expect(await run({ type: "folder", path: "Notes/Projects", files: 3 })).toEqual({ ok: false, reason: "has_drafts", detail: 2 });
    expect(await fake.branchHead()).toBe(head);
  });

  it("is not for a folder with a vault's manifest in it", async () => {
    const head = await seed({ "Notes/Nested/fjord.vault.json": VAULT, "Notes/Nested/a.md": "a" });
    expect(await run({ type: "folder", path: "Notes/Nested", files: 2 })).toEqual({ ok: false, reason: "protected" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)(`unsaved changes (${leg})`, () => {
  it("are saved as a version first, and the deletion is on top of it", async () => {
    const before = await seed({ "Notes/n.md": "original\n" });
    const target = await file("Notes/n.md");
    await drafts.save(1, "Notes/n.md", { baseBlob: target.type === "file" ? target.blob : "", content: "edited, not saved\n" }, { type: "account", id: "ada" });
    let versionCommit = "";
    const saveDraft = vi.fn(async (): Promise<VersionResult> => {
      versionCommit = await fake.commitFiles({ "Notes/n.md": "edited, not saved\n" }, { message: "Edit n" });
      return { ok: true, commit: versionCommit };
    });

    const result = await run(target, { saveDraft });
    expect(result).toMatchObject({ ok: true, files: 1 });
    const commit = (result as { commit: string }).commit;
    expect(saveDraft).toHaveBeenCalledWith("Notes/n.md");
    expect(await fake.show(commit, "%P")).toBe(versionCommit);
    expect(versionCommit).not.toBe(before);
    // What is recorded to put back is the version, with the edits, not the file as the page first showed it.
    const [record] = await deletions.get(1, (result as { deletions: number[] }).deletions);
    expect(await h.provider.readBlob(h.repo, record!.blob).then((bytes) => new TextDecoder().decode(bytes))).toBe("edited, not saved\n");
  });

  it("stop the deletion when they cannot be saved: nothing is deleted", async () => {
    const head = await seed({ "Notes/n.md": "original\n" });
    const target = await file("Notes/n.md");
    await drafts.save(1, "Notes/n.md", { baseBlob: "x", content: "edited\n" }, { type: "account", id: "ada" });
    expect(await run(target, { saveDraft: async () => ({ ok: false, reason: "upstream_changed" }) })).toEqual({ ok: false, reason: "draft_not_saved", detail: "upstream_changed" });
    expect(await fake.branchHead()).toBe(head);
    expect(await deletions.list(1, 1e12)).toEqual([]);
  });

  it("are not asked about for a file that has none", async () => {
    await seed({ "Notes/n.md": "x" });
    const saveDraft = vi.fn(noVersion);
    expect(await run(await file("Notes/n.md"), { saveDraft })).toMatchObject({ ok: true });
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe.skipIf(!available)(`when others are writing too, and when it goes wrong (${leg})`, () => {
  it("goes on top of a head that moved without touching the file, once", async () => {
    await seed({ "Notes/n.md": "x", "Notes/other.md": "o" });
    const target = await file("Notes/n.md");
    let theirs = "";
    fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs = await fake.commitFiles({ "Notes/other.md": "changed" })), "PATCH");
    const result = (await run(target)) as { commit: string };
    expect(await fake.show(result.commit, "%P")).toBe(theirs);
    expect(await fake.filesAt(result.commit)).toEqual({ "Notes/fjord.vault.json": VAULT, "Notes/other.md": "changed" });
  });

  it("deletes nothing of theirs when the file itself changes as it is committed", async () => {
    await seed({ "Notes/n.md": "x" });
    const target = await file("Notes/n.md");
    let theirs = "";
    fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs = await fake.commitFiles({ "Notes/n.md": "theirs" })), "PATCH");
    expect(await run(target)).toEqual({ ok: false, reason: "upstream_changed" });
    expect(await fake.branchHead()).toBe(theirs);
    expect((await fake.filesAt(theirs))["Notes/n.md"]).toBe("theirs");
  });

  it("gives up, without forcing, when the head keeps moving", async () => {
    await seed({ "Notes/n.md": "x" });
    const target = await file("Notes/n.md");
    let n = 0;
    for (let i = 0; i < 2; i++) fake.before(/\/git\/refs\/heads\/main$/, async () => void (await fake.commitFiles({ [`Notes/race ${++n}.md`]: "r" })), "PATCH");
    expect(await run(target)).toEqual({ ok: false, reason: "head_moved" });
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/n.md"]).toBe("x");
    expect(fake.requests.filter((r) => r.method === "PATCH").every((r) => (r.body as { force?: boolean }).force === false)).toBe(true);
  });

  it("says so, and deletes and records nothing, when the token cannot write, was revoked, or the host is down", async () => {
    const head = await seed({ "Notes/n.md": "x" });
    const target = await file("Notes/n.md");
    expect(await run(target, {}, h.readOnly!())).toEqual({ ok: false, reason: "read_only" });
    expect(await run(target, {}, h.revoked!())).toEqual({ ok: false, reason: "bad_token" });
    fake.fail(/.*/, { status: 503, body: { message: "down" }, times: 20 });
    expect(await run(target)).toEqual({ ok: false, reason: "unavailable" });
    expect(await fake.branchHead()).toBe(head);
    expect(await deletions.list(1, 1e12)).toEqual([]);
  });

  it("is a deletion all the same if the record of it cannot be kept", async () => {
    await seed({ "Notes/n.md": "x" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await run(await file("Notes/n.md"), { deletions: { record: async () => Promise.reject(new Error("db down")) } });
    expect(result).toMatchObject({ ok: true, files: 1, deletions: [] });
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/n.md"]).toBeUndefined();
    logged.mockRestore();
  });
});

describe("what a deleted thing is called", () => {
  it("is the name without .fj.md or .md, and a folder or another file as it is", () => {
    expect(deletedName("Notes/Q4 plan.fj.md")).toBe("Q4 plan");
    expect(deletedName("Notes/Weekly review.md")).toBe("Weekly review");
    expect(deletedName("Notes/Projects")).toBe("Projects");
    expect(deletedName("Notes/pic.png")).toBe("pic.png");
    expect(deletedName("Notes/NOTES.MD")).toBe("NOTES");
  });
});
