import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity, Provider } from "../providers/types";
import { checkVault, createFile, type CreateDeps } from "./create";
import type { VaultListing } from "../format/types";

/**
 * Making a new file (ROADMAP 1b.7) against a GitHub whose storage is a real git repository, with `fjord-core`'s own
 * naming and header as WebAssembly. What git says about the commit is what is asserted: its parent, its author, the one
 * file it adds. And what `fjord-core` then says about the file: that it is a note, or a document.
 *
 * It needs the format module built (`pnpm build:wasm`); where it is not, these are skipped, except in CI.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const VAULT = JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" });

beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h?.close());

const deps = (provider: Provider = h.provider, over: Partial<CreateDeps> = {}): CreateDeps => ({
  provider,
  ref: h.repo,
  branch: "main",
  format: fjord(),
  now: () => 1_800_000_000_000,
  random: () => new Uint8Array(16).fill(7),
  ...over,
});
const create = (input: Partial<Parameters<typeof createFile>[1]> = {}, provider?: Provider, over?: Partial<CreateDeps>) =>
  createFile(deps(provider, over), { vault: "Notes", folder: "", kind: "note", title: "", localMinute: WHEN, author: ADA, ...input });
const seed = (files: Record<string, string> = {}) => h.seed({ "Notes/fjord.vault.json": VAULT, ...files });
const added = async (before: string, after: string) => {
  const was = Object.keys(await fake.filesAt(before));
  return Object.keys(await fake.filesAt(after)).filter((path) => !was.includes(path));
};

describe.skipIf(!available)("a new note", () => {
  it("is one commit that adds one file, named from its title, by the person, on top of the head", async () => {
    const before = await seed({ "Notes/other.md": "o" });
    const result = await create({ title: "Meeting notes" });
    expect(result).toEqual({ ok: true, path: "Notes/Meeting notes.md", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const commit = (result as { commit: string }).commit;
    expect(await fake.branchHead()).toBe(commit);
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await added(before, commit)).toEqual(["Notes/Meeting notes.md"]);
    expect((await fake.filesAt(commit))["Notes/Meeting notes.md"]).toBe("# Meeting notes\n");
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Create Meeting notes");
    await fake.fsck();
  });

  it("without a title is an empty file named by the local date and time, numbered when the minute is taken", async () => {
    await seed();
    const first = (await create()) as { path: string; commit: string };
    expect(first.path).toBe("Notes/2026-10-22 1430.md");
    expect((await fake.filesAt(first.commit))[first.path]).toBe("");
    expect(((await create()) as { path: string }).path).toBe("Notes/2026-10-22 1430 2.md");
  });

  it("is named past what the folder has, case aside, and files and folders both count", async () => {
    await seed({ "Notes/Plan.md": "p", "Notes/PLAN 2.md": "p", "Notes/Archive/x.md": "x" });
    expect(((await create({ title: "plan" })) as { path: string }).path).toBe("Notes/plan 3.md");
    expect(((await create({ title: "Archive" })) as { path: string }).path).toBe("Notes/Archive.md");
  });

  it("goes in the folder it was asked for, however deep", async () => {
    await seed({ "Notes/Projects/2026/a.md": "a" });
    expect(((await create({ folder: "Projects/2026", title: "Todo" })) as { path: string }).path).toBe("Notes/Projects/2026/Todo.md");
  });

  it("is named by what is left of a title once what a file name cannot hold is gone, and the text keeps the title", async () => {
    await seed();
    const result = (await create({ title: "a/b: c?" })) as { path: string; commit: string };
    expect(result.path).toBe("Notes/a b c.md");
    expect((await fake.filesAt(result.commit))[result.path]).toBe("# a/b: c?\n");
    const long = "word ".repeat(30).trim();
    const cut = (await create({ title: long })) as { path: string };
    expect(cut.path.length).toBeLessThanOrEqual("Notes/".length + 60 + ".md".length);
    expect(((await create({ title: "日本語のノート" })) as { path: string }).path).toBe("Notes/日本語のノート.md");
  });

  it("keeps the white space round a title out of the text and the name", async () => {
    await seed();
    const result = (await create({ title: "  Plan  \t" })) as { path: string; commit: string };
    expect(result.path).toBe("Notes/Plan.md");
    expect((await fake.filesAt(result.commit))[result.path]).toBe("# Plan\n");
    const doc = (await create({ kind: "document", title: "  Q4 plan " })) as { path: string; commit: string };
    expect((await fake.filesAt(doc.commit))[doc.path]).toContain("title: Q4 plan\n");
  });

  it("is a note the format module recognises", async () => {
    await seed({ "Notes/a.md": "a" });
    const { commit, path } = (await create({ title: "Idea" })) as { path: string; commit: string };
    const tree = await h.provider.getTree(h.repo, commit);
    const files = tree.entries.filter((entry) => entry.kind === "file").map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
    const found = fjord().discover(files, { "Notes/fjord.vault.json": VAULT });
    expect(found.vaults[0]!.files.find((file) => file.path === path)).toMatchObject({ kind: "note", logical: "Idea.md" });
  });
});

describe.skipIf(!available)("a new document", () => {
  it("has a header written by fjord-core, a heading, and a name from its title with .fj.md", async () => {
    await seed();
    const result = (await create({ kind: "document", title: "Q4: plan" })) as { path: string; commit: string };
    expect(result.path).toBe("Notes/Q4 plan.fj.md");
    const text = (await fake.filesAt(result.commit))[result.path]!;
    const id = fjord().newUlid(1_800_000_000_000, new Uint8Array(16).fill(7));
    expect(text).toBe(fjord().newDocument(id, "Q4: plan", "2027-01-15T08:00:00Z"));
    expect(text).toMatch(/^---\nid: [0-9a-z]{26}\ntitle: "Q4: plan"\ncreated: "2027-01-15T08:00:00Z"\n---\n\n# Q4: plan\n$/);
    expect(await fake.show(result.commit, "%B")).toBe("Create Q4 plan");
  });

  it("is a document the format module recognises, and a note of the same name does not stop it", async () => {
    await seed({ "Notes/Q4 plan.md": "a note" });
    const { commit, path } = (await create({ kind: "document", title: "Q4 plan" })) as { path: string; commit: string };
    expect(path).toBe("Notes/Q4 plan.fj.md");
    const tree = await h.provider.getTree(h.repo, commit);
    const files = tree.entries.filter((entry) => entry.kind === "file").map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
    const found = fjord().discover(files, { "Notes/fjord.vault.json": VAULT });
    expect(found.vaults[0]!.files.find((file) => file.path === path)?.kind).toBe("document");
  });

  it("is numbered when a document of that name is there", async () => {
    await seed({ "Notes/Q4 plan.fj.md": "d" });
    expect(((await create({ kind: "document", title: "Q4 plan" })) as { path: string }).path).toBe("Notes/Q4 plan 2.fj.md");
  });

  it.each(["", "   ", "***", "...", "# "])("needs a title with something to name a file by: %j is refused, and nothing is written", async (title) => {
    const head = await seed();
    expect(await create({ kind: "document", title })).toEqual({ ok: false, reason: "bad_title" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)("where it goes", () => {
  it("is refused for a folder that is not there, and nothing is written", async () => {
    const head = await seed();
    expect(await create({ folder: "Nowhere", title: "x" })).toEqual({ ok: false, reason: "folder_gone" });
    expect(await create({ vault: "NoVault", title: "x" })).toEqual({ ok: false, reason: "folder_gone" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe.skipIf(!available)("when others are writing too", () => {
  it("takes the next free name when the same name is made while it is being committed, and loses neither file", async () => {
    await seed();
    let theirs = "";
    fake.before(/\/git\/refs\/heads\/main$/, async () => void (theirs = await fake.commitFiles({ "Notes/Plan.md": "theirs" })), "PATCH");
    const result = (await create({ title: "Plan" })) as { path: string; commit: string };
    expect(result.path).toBe("Notes/Plan 2.md");
    expect(await fake.show(result.commit, "%P")).toBe(theirs);
    expect(await fake.filesAt(result.commit)).toMatchObject({ "Notes/Plan.md": "theirs", "Notes/Plan 2.md": "# Plan\n" });
    await fake.fsck();
  });

  it("gives up, without forcing, when the head keeps moving", async () => {
    await seed();
    let n = 0;
    for (let i = 0; i < 2; i++) fake.before(/\/git\/refs\/heads\/main$/, async () => void (await fake.commitFiles({ [`Notes/race ${++n}.md`]: "r" })), "PATCH");
    expect(await create({ title: "Plan" })).toEqual({ ok: false, reason: "head_moved" });
    expect(Object.keys(await fake.filesAt((await fake.branchHead())!)).some((path) => path.includes("Plan"))).toBe(false);
    expect(fake.requests.filter((r) => r.method === "PATCH").every((r) => (r.body as { force?: boolean }).force === false)).toBe(true);
  });
});

describe.skipIf(!available)("what goes wrong", () => {
  it("says so, and writes nothing, when the token cannot write, was revoked, or the host is down", async () => {
    const head = await seed();
    expect(await create({ title: "x" }, h.readOnly!())).toEqual({ ok: false, reason: "read_only" });
    expect(await create({ title: "x" }, h.revoked!())).toEqual({ ok: false, reason: "bad_token" });
    expect(await fake.branchHead()).toBe(head);
    fake.fail(/.*/, { status: 503, body: { message: "down" }, times: 20 });
    expect(await create({ title: "x" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await fake.branchHead()).toBe(head);
  });
});

describe("which vaults are written to", () => {
  const vault = (over: Partial<VaultListing>): VaultListing => ({ directory: "Notes", name: "Notes", encrypted: false, fileNaming: "plain", suffix: null, manifestError: null, files: [], ...over });

  it("a plaintext vault with plain names, and no other", () => {
    expect(checkVault([vault({})], "Notes")).toBe("ok");
    expect(checkVault([vault({})], "Other")).toBe("unknown_vault");
    expect(checkVault([vault({ encrypted: true, suffix: ".age" })], "Notes")).toBe("encrypted_vault");
    expect(checkVault([vault({ manifestError: "not JSON" })], "Notes")).toBe("unsupported_vault"); // whatever else it seems to say
    expect(checkVault([vault({ manifestError: "not JSON", encrypted: null, fileNaming: null })], "Notes")).toBe("unsupported_vault");
    expect(checkVault([vault({ fileNaming: "id" })], "Notes")).toBe("unsupported_vault");
    expect(checkVault([vault({ fileNaming: null })], "Notes")).toBe("unsupported_vault");
    expect(checkVault([vault({ encrypted: null })], "Notes")).toBe("unsupported_vault");
    expect(checkVault([], "Notes")).toBe("unknown_vault");
  });

  it("the vault asked for, not another that is fine", () => {
    expect(checkVault([vault({ directory: "Private", encrypted: true }), vault({})], "Private")).toBe("encrypted_vault");
  });
});
