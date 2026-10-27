import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { ProviderError } from "../providers/errors";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity } from "../providers/types";
import { WorkingCopyService } from "../working/service";
import type { VersionResult } from "../working/version";
import type { DeleteTarget } from "./delete";
import { type MoveDeps, type MoveResult, movePath, moveMessage } from "./move";

/**
 * Renaming and moving (ROADMAP 1b.11) against a GitHub whose storage is a real git repository: what git says about the commit is
 * what is asserted. Drafts are on the real databases. Needs the format module built, as `delete.test.ts` does.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const { leg } = testTarget();
let database: Database;
let drafts: WorkingCopyService;
let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });
const DOC = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Plan\nx-future: [kept]\n# a comment\n---\r\n\r\n# Plan\r\n";
const draftTable = () => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);

beforeAll(async () => {
  if (!available) return;
  ({ database } = await freshDatabase());
  await runMigrations(database);
  drafts = new WorkingCopyService(database);
});
afterAll(async () => database?.close());
beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
  await dbRun(database, sql`DELETE FROM ${draftTable()}`);
});
afterEach(async () => h?.close());

const noVersion = async (): Promise<VersionResult> => ({ ok: false, reason: "unavailable" });
const deps = (over: Partial<MoveDeps> = {}): MoveDeps => ({ provider: h.provider, ref: h.repo, branch: "main", format: fjord(), drafts, saveDraft: noVersion, ...over });
const seed = (files: Record<string, string> = {}) => h.seed({ "Notes/fjord.vault.json": VAULT, "Other/fjord.vault.json": VAULT, ...files });
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
const file = async (path: string): Promise<DeleteTarget> => ({ type: "file", path, blob: await blobOf(path) });
const folder = (path: string, files: number): DeleteTarget => ({ type: "folder", path, files });
const run = (target: DeleteTarget, destination: string, over: Partial<MoveDeps> = {}, vault = "Notes") => movePath(deps(over), { connectionId: 1, vault, target, destination, author: ADA });
const reason = (result: MoveResult) => (result.ok ? "ok" : result.reason);

describe("a commit's message", () => {
  it("says rename when the folder is the same and move when it is not", () => {
    expect(moveMessage("Notes/a.md", "Notes/b.md", 1, false)).toBe("Rename a to b");
    expect(moveMessage("Notes/Plan.fj.md", "Notes/Plan 2.fj.md", 1, false)).toBe("Rename Plan to Plan 2");
    expect(moveMessage("Notes/a.md", "Notes/Sub/a.md", 1, false)).toBe("Move a to Notes/Sub");
    expect(moveMessage("Notes/a.md", "Notes/Sub/b.md", 1, false)).toBe("Move Notes/a.md to Notes/Sub/b.md");
    expect(moveMessage("Notes/Old", "Notes/New", 3, true)).toBe("Rename Old to New\n\nMoves 3 files.");
  });
});

describe.skipIf(!available)(`renaming and moving a file (${leg})`, () => {
  it("is one commit that puts the same blob at the new path and takes the old one away, byte for byte, by the person", async () => {
    const before = await seed({ "Notes/Plan.fj.md": DOC, "Notes/other.md": "o" });
    const blob = await blobOf("Notes/Plan.fj.md");
    const result = await run({ type: "file", path: "Notes/Plan.fj.md", blob }, "Notes/Plans/Plan v2.fj.md");
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), files: 1, moved: [{ from: "Notes/Plan.fj.md", to: "Notes/Plans/Plan v2.fj.md" }] });
    const commit = (result as { commit: string }).commit;
    expect(await fake.branchHead()).toBe(commit);
    expect(await fake.show(commit, "%P")).toBe(before);
    const files = await fake.filesAt(commit);
    expect(Object.keys(files).sort()).toEqual(["Notes/Plans/Plan v2.fj.md", "Notes/fjord.vault.json", "Notes/other.md", "Other/fjord.vault.json"]);
    expect(files["Notes/Plans/Plan v2.fj.md"]).toBe(DOC); // every byte, the header and the CRLF body and the comment too
    expect(await blobOf("Notes/Plans/Plan v2.fj.md")).toBe(blob);
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Move Notes/Plan.fj.md to Notes/Plans/Plan v2.fj.md");
    await fake.fsck();
  });

  it("renames in place with a message that says so, and moves into another plaintext vault", async () => {
    await seed({ "Notes/a.md": "a", "Notes/b.md": "b" });
    const renamed = await run(await file("Notes/a.md"), "Notes/a2.md");
    expect(reason(renamed)).toBe("ok");
    expect(await fake.show((await fake.branchHead())!, "%B")).toBe("Rename a to a2");
    const moved = await run(await file("Notes/b.md"), "Other/b.md");
    expect(reason(moved)).toBe("ok");
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!)).sort()).toEqual(["Notes/a2.md", "Notes/fjord.vault.json", "Other/b.md", "Other/fjord.vault.json"]);
  });

  it("allows a name that differs from the file's own only by case", async () => {
    await seed({ "Notes/plan.md": "p" });
    expect(reason(await run(await file("Notes/plan.md"), "Notes/Plan.md"))).toBe("ok");
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!)).filter((path) => path.endsWith(".md"))).toEqual(["Notes/Plan.md"]);
  });

  it("keeps a file's executable bit, which a note can have from another tool", async () => {
    await seed({ "Notes/a.md": "a" });
    const head = await h.provider.getHead(h.repo, "main");
    if (!head.changed) throw new Error("no head");
    await h.provider.commit(h.repo, { branch: "main", expectedHead: head.head.commit, message: "make it executable", changes: [{ path: "Notes/run.md", content: new TextEncoder().encode("#!/bin/sh\n"), executable: true }] });
    expect(reason(await run(await file("Notes/run.md"), "Notes/Sub/run.md"))).toBe("ok");
    const after = await h.provider.getHead(h.repo, "main");
    if (!after.changed) throw new Error("no head");
    const entry = (await h.provider.listDirectory(h.repo, after.head.commit, "Notes/Sub")).find((candidate) => candidate.path === "Notes/Sub/run.md");
    expect(entry?.executable).toBe(true);
  });

  it("never goes over anything: a taken path, a name alike by case, or a file in the way is refused and named, and nothing is written", async () => {
    const before = await seed({ "Notes/a.md": "a", "Notes/b.md": "b", "Notes/Sub/readme.md": "r", "Notes/blocker": "a file where a folder must go" });
    const target = await file("Notes/a.md");
    for (const [destination, taken] of [
      ["Notes/b.md", "Notes/b.md"],
      ["Notes/B.md", "Notes/B.md"],
      ["Notes/Sub/README.md", "Notes/Sub/README.md"],
      ["Notes/blocker/a.md", "Notes/blocker/a.md"],
      ["Notes/Blocker/a.md", "Notes/Blocker/a.md"],
    ] as const) {
      expect(await run(target, destination), destination).toEqual({ ok: false, reason: "path_taken", taken: [taken] });
    }
    expect(await fake.branchHead()).toBe(before);
  });

  it("keeps the extension: a document never becomes a note, nor a note a document", async () => {
    const before = await seed({ "Notes/Plan.fj.md": DOC, "Notes/n.md": "n" });
    expect(reason(await run(await file("Notes/Plan.fj.md"), "Notes/Plan.md"))).toBe("extension_changed");
    expect(reason(await run(await file("Notes/n.md"), "Notes/n.fj.md"))).toBe("extension_changed");
    expect(reason(await run(await file("Notes/n.md"), "Notes/n.txt"))).toBe("extension_changed");
    expect(await fake.branchHead()).toBe(before);
  });

  it("checks every name by the format's path rules, and refuses the machinery, a place of no vault, and the file itself", async () => {
    const before = await seed({ "Notes/a.md": "a" });
    const target = await file("Notes/a.md");
    for (const destination of ["Notes/a/b/../c.md", "Notes/CON.md", "Notes/trailing.md ", "Notes/ends with.md.", "Notes/.git/a.md", "Notes//a.md", "a.md", "Notes/bad:name.md", "Notes/\u0007.md"]) {
      expect(reason(await run(target, destination)), destination).toBe("bad_path");
    }
    expect(reason(await run(target, "Notes/fjord.vault.json"))).toBe("protected");
    expect(reason(await run(target, "Notes/a.md"))).toBe("unchanged");
    expect(reason(await run(target, "Notes/a.md/inside.md"))).toBe("into_itself");
    expect(await fake.branchHead()).toBe(before);
  });

  it("does not move a vault, its manifest or the repository's files", async () => {
    await seed({ "Notes/a.md": "a", "fjord.json": "{}" });
    expect(reason(await run({ type: "file", path: "Notes/fjord.vault.json", blob: await blobOf("Notes/fjord.vault.json") }, "Notes/moved.json"))).toBe("protected");
    expect(reason(await run(folder("Notes", 2), "Other/Notes"))).toBe("protected");
    expect(reason(await run({ type: "file", path: "fjord.json", blob: await blobOf("fjord.json") }, "Notes/fjord.json", {}, "Notes"))).toBe("protected");
  });

  it("moves only the version that was shown, and says when the file is gone", async () => {
    await seed({ "Notes/a.md": "one" });
    const shown = await file("Notes/a.md");
    await fake.commitFiles({ "Notes/a.md": "two" });
    const head = await fake.branchHead();
    expect(reason(await run(shown, "Notes/b.md"))).toBe("upstream_changed");
    expect(reason(await run({ type: "file", path: "Notes/nothing.md", blob: "a".repeat(40) }, "Notes/b.md"))).toBe("gone");
    expect(await fake.branchHead()).toBe(head);
  });

  it("reads the head again once if it moved, and gives up if it moves again", async () => {
    await seed({ "Notes/a.md": "a" });
    const target = await file("Notes/a.md");
    const real = h.provider.commit.bind(h.provider);
    let calls = 0;
    const flaky = vi.spyOn(h.provider, "commit").mockImplementation(async (ref, request) => {
      if (++calls === 1) throw new ProviderError("head_moved", "moved");
      return real(ref, request);
    });
    expect(reason(await run(target, "Notes/b.md"))).toBe("ok");
    expect(calls).toBe(2);
    flaky.mockImplementation(async () => {
      throw new ProviderError("head_moved", "moved");
    });
    expect(reason(await run(await file("Notes/b.md"), "Notes/c.md"))).toBe("head_moved");
  });

  it("saves unsaved changes as a version first, moves what that made, and stops if that cannot be done", async () => {
    await seed({ "Notes/a.md": "a" });
    await drafts.save(1, "Notes/a.md", { baseBlob: await blobOf("Notes/a.md"), content: "a, edited" }, { type: "account", id: "ada" });
    expect(reason(await run(await file("Notes/a.md"), "Notes/b.md"))).toBe("draft_not_saved");
    expect(await blobOf("Notes/a.md")).toBeTruthy(); // still there

    const saveDraft = vi.fn(async (path: string): Promise<VersionResult> => {
      await fake.commitFiles({ [path]: "a, edited" });
      return { ok: true, commit: (await fake.branchHead())! } as unknown as VersionResult;
    });
    const result = await run(await file("Notes/a.md"), "Notes/b.md", { saveDraft });
    expect(reason(result)).toBe("ok");
    expect(saveDraft).toHaveBeenCalledWith("Notes/a.md");
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/b.md"]).toBe("a, edited");
  });

  it("will not go to a place that has an unsaved draft of its own", async () => {
    await seed({ "Notes/a.md": "a" });
    await drafts.save(1, "Notes/b.md", { baseBlob: "b".repeat(40), content: "a draft of a note that is gone" }, { type: "account", id: "ada" });
    expect(await run(await file("Notes/a.md"), "Notes/b.md")).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/b.md"] });
  });
});

describe.skipIf(!available)(`renaming and moving a folder (${leg})`, () => {
  const tree = { "Notes/Old/a.md": "a", "Notes/Old/Deep/b.fj.md": DOC, "Notes/Old/Deep/c.md": "c", "Notes/keep.md": "k" };

  it("is one commit that moves every file in it to the same place under the new name, and nothing else", async () => {
    const before = await seed(tree);
    const result = await run(folder("Notes/Old", 3), "Other/Archive/New");
    expect(result).toMatchObject({ ok: true, files: 3 });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.show(commit, "%B")).toBe("Move Notes/Old to Other/Archive/New\n\nMoves 3 files.");
    const files = await fake.filesAt(commit);
    expect(Object.keys(files).sort()).toEqual([
      "Notes/fjord.vault.json",
      "Notes/keep.md",
      "Other/Archive/New/Deep/b.fj.md",
      "Other/Archive/New/Deep/c.md",
      "Other/Archive/New/a.md",
      "Other/fjord.vault.json",
    ]);
    expect(files["Other/Archive/New/Deep/b.fj.md"]).toBe(DOC);
    await fake.fsck();
  });

  it("renames in place with a message that says so", async () => {
    await seed(tree);
    expect(reason(await run(folder("Notes/Old", 3), "Notes/Older"))).toBe("ok");
    const message = await fake.show((await fake.branchHead())!, "%B");
    expect(message).toBe("Rename Old to Older\n\nMoves 3 files.");
  });

  it("is not into itself, not over a folder that is there (nothing here merges), and not over a name alike by case", async () => {
    const before = await seed({ ...tree, "Notes/Other/x.md": "x" });
    expect(reason(await run(folder("Notes/Old", 3), "Notes/Old/Inside"))).toBe("into_itself");
    expect(await run(folder("Notes/Old", 3), "Notes/Other")).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/Other"] });
    expect(await run(folder("Notes/Old", 3), "Notes/OTHER")).toEqual({ ok: false, reason: "path_taken", taken: ["Notes/OTHER"] });
    expect(await fake.branchHead()).toBe(before);
  });

  it("may be renamed to a name that differs from its own only by case", async () => {
    await seed(tree);
    expect(reason(await run(folder("Notes/Old", 3), "Notes/old"))).toBe("ok");
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!)).filter((path) => path.startsWith("Notes/old/")).length).toBe(3);
  });

  it("does not move a folder with a link in it: a commit of a blob cannot say it is one", async () => {
    const before = await seed(tree);
    const real = h.provider.getTree.bind(h.provider);
    vi.spyOn(h.provider, "getTree").mockImplementation(async (ref, commit) => {
      const found = await real(ref, commit);
      return { ...found, entries: [...found.entries, { path: "Notes/Old/link", kind: "symlink" as const, id: "c".repeat(40), executable: false }] };
    });
    expect(reason(await run(folder("Notes/Old", 4), "Notes/Older"))).toBe("protected");
    expect(await fake.branchHead()).toBe(before);
  });

  it("moves only the folder that was counted, and not one with drafts in it, or too many files", async () => {
    const before = await seed(tree);
    expect(await run(folder("Notes/Old", 2), "Notes/New")).toEqual({ ok: false, reason: "folder_changed", detail: 3 });
    expect(reason(await run(folder("Notes/Nothing", 1), "Notes/New"))).toBe("gone");
    expect(reason(await run(folder("Notes/Old", 3), "Notes/New", { maxFiles: 2 }))).toBe("too_many");
    await drafts.save(1, "Notes/Old/a.md", { baseBlob: await blobOf("Notes/Old/a.md"), content: "unsaved" }, { type: "account", id: "ada" });
    expect(await run(folder("Notes/Old", 3), "Notes/New")).toEqual({ ok: false, reason: "has_drafts", detail: 1 });
    expect(await fake.branchHead()).toBe(before);
  });
});

describe.skipIf(!available)(`when the host says no (${leg})`, () => {
  it.each([
    ["forbidden", "read_only"],
    ["unauthorized", "bad_token"],
    ["unavailable", "unavailable"],
    ["rate_limited", "unavailable"],
  ] as const)("%s is %s", async (code, expected) => {
    await seed({ "Notes/a.md": "a" });
    const target = await file("Notes/a.md");
    vi.spyOn(h.provider, "commit").mockRejectedValue(new ProviderError(code, "no"));
    expect(reason(await run(target, "Notes/b.md"))).toBe(expected);
  });
});
