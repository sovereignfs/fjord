import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { VaultListing } from "../format/types";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity } from "../providers/types";
import { encryptedDraft } from "../working/test-ciphertext";
import { type CreateEncryptedDeps, type EncryptedTarget, checkEncryptedVault, createEncryptedFile } from "./create-encrypted";

/**
 * Making a file in an encrypted vault (ROADMAP 2b.4) against a GitHub whose storage is a real git repository, with `fjord-core`'s own naming as WebAssembly. What
 * git says about the commit is what is asserted: one new file, the bytes the browser made as they are, the name, and that nothing readable is in it. It needs the
 * format module built (`pnpm build:wasm`).
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const manifest = (naming: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Secret", createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: naming === "id" ? "tar" : "none", armor: false, ...over }, fileNaming: naming });
const PLAIN: EncryptedTarget = { naming: "plain", suffix: ".age" };
const BY_ID: EncryptedTarget = { naming: "id", suffix: ".age" };

beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h?.close());

const deps = (): CreateEncryptedDeps => ({ provider: h.provider, ref: h.repo, branch: "main", format: fjord(), now: () => 1_800_000_000_000, random: () => new Uint8Array(16).fill(7) });
const create = (target: EncryptedTarget, input: { title?: string; kind?: "note" | "document"; folder?: string; bytes?: Uint8Array } = {}) =>
  createEncryptedFile(deps(), { vault: "Secret", folder: input.folder ?? "", target, kind: input.kind ?? "note", title: input.title ?? "", localMinute: WHEN, ciphertext: input.bytes ?? encryptedDraft("SECRET PLAINTEXT").bytes, author: ADA });
const seed = (naming: "plain" | "id", files: Record<string, string> = {}) => h.seed({ "Secret/fjord.vault.json": manifest(naming), "Secret/recipients.txt": "age1x\n", ...files });

describe.skipIf(!available)("a new file in a plain-named encrypted vault", () => {
  it("is one commit that adds one file named from its title and the suffix, holding the bytes as they were made", async () => {
    const before = await seed("plain", { "Secret/other.md.age": "x" });
    const { bytes } = encryptedDraft("SECRET PLAINTEXT");
    const result = await create(PLAIN, { title: "Meeting notes", bytes });
    expect(result).toEqual({ ok: true, path: "Secret/Meeting notes.md.age", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.show(commit, "%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await fake.show(commit, "%B")).toBe("Create Meeting notes");
    expect([...(await fake.fileBytesAt(commit, "Secret/Meeting notes.md.age"))]).toEqual([...bytes]);
    expect(Object.keys(await fake.filesAt(commit)).sort()).toEqual(["Secret/Meeting notes.md.age", "Secret/fjord.vault.json", "Secret/other.md.age", "Secret/recipients.txt"]);
    await fake.fsck();
  });

  it("names a document from its title with .fj.md, and numbers past what is there, case aside, by the file's real name", async () => {
    await seed("plain", { "Secret/Plan.fj.md.age": "x", "Secret/PLAN 2.fj.md.age": "x", "Secret/Plan.md.age": "x" });
    expect(((await create(PLAIN, { kind: "document", title: "plan" })) as { path: string }).path).toBe("Secret/plan 3.fj.md.age");
    // A note and a document are different names (Plan.md and Plan.fj.md); a note called Plan is numbered past the note.
    expect(((await create(PLAIN, { title: "plan" })) as { path: string }).path).toBe("Secret/plan 2.md.age");
  });

  it("names a note with no title by the writer's date and time, numbered when the minute is taken", async () => {
    await seed("plain");
    expect(((await create(PLAIN)) as { path: string }).path).toBe("Secret/2026-10-22 1430.md.age");
    expect(((await create(PLAIN)) as { path: string }).path).toBe("Secret/2026-10-22 1430 2.md.age");
  });

  it("goes into the folder asked for, and needs a title to make a document", async () => {
    await seed("plain", { "Secret/Projects/a.md.age": "a" });
    expect(((await create(PLAIN, { folder: "Projects", title: "Todo" })) as { path: string }).path).toBe("Secret/Projects/Todo.md.age");
    expect(await create(PLAIN, { kind: "document", title: "?!" })).toEqual({ ok: false, reason: "bad_title" });
    expect(await create(PLAIN, { folder: "Nowhere", title: "x" })).toEqual({ ok: false, reason: "folder_gone" });
  });

  it("is the file `fjord-core` says is an encrypted payload with that name, and no plaintext of it is anywhere", async () => {
    await seed("plain");
    const { commit, path } = (await create(PLAIN, { title: "Idea" })) as { path: string; commit: string };
    const tree = await h.provider.getTree(h.repo, commit);
    const files = tree.entries.filter((entry) => entry.kind === "file").map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
    const found = fjord().discover(files, { "Secret/fjord.vault.json": manifest("plain") });
    expect(found.vaults[0]!.files.find((file) => file.path === path)).toMatchObject({ kind: "payload", logical: "Idea.md" });
    for (const [name, text] of Object.entries(await fake.filesAt(commit))) expect(text, name).not.toContain("SECRET PLAINTEXT");
  });
});

describe.skipIf(!available)("a new file in an id-named encrypted vault", () => {
  it("is called by a new identifier and the suffix, and the commit says nothing of the file", async () => {
    await seed("id", { "Secret/01jagc4k7pr9tbm3ykwx6zq2hz.age": "x" });
    const result = (await create(BY_ID, { title: "" })) as { path: string; commit: string };
    expect(result.path).toMatch(/^Secret\/[0-9a-hjkmnp-tv-z]{26}\.age$/);
    expect(result.path).not.toBe("Secret/01jagc4k7pr9tbm3ykwx6zq2hz.age");
    expect(await fake.show(result.commit, "%B")).toBe("Create an encrypted file");
  });

  it("is a payload `fjord-core` knows by its identifier", async () => {
    await seed("id");
    const { commit, path } = (await create(BY_ID)) as { path: string; commit: string };
    const tree = await h.provider.getTree(h.repo, commit);
    const files = tree.entries.filter((entry) => entry.kind === "file").map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
    const found = fjord().discover(files, { "Secret/fjord.vault.json": manifest("id") });
    expect(found.vaults[0]!.files.find((file) => file.path === path)).toMatchObject({ kind: "payload" });
  });
});

describe.skipIf(!available)("when the repository moves", () => {
  it("takes the next free name on top of a head that moved meanwhile, and writes nothing over anything", async () => {
    await seed("plain");
    const first = (await create(PLAIN, { title: "Same" })) as { path: string };
    const second = (await create(PLAIN, { title: "Same" })) as { path: string };
    expect([first.path, second.path]).toEqual(["Secret/Same.md.age", "Secret/Same 2.md.age"]);
  });
});

describe("which encrypted vaults can be written to", () => {
  const vault = (over: Partial<VaultListing> = {}): VaultListing => ({ directory: "Secret", name: "Secret", encrypted: true, fileNaming: "plain", suffix: ".age", manifestError: null, files: [], ...over });
  const manifests = (naming: string, over: Record<string, unknown> = {}) => ({ "Secret/fjord.vault.json": manifest(naming, over) });

  it("is a vault of age with binary files and the container its naming needs", () => {
    expect(checkEncryptedVault([vault()], manifests("plain"), "Secret")).toEqual({ ok: true, target: PLAIN });
    expect(checkEncryptedVault([vault({ fileNaming: "id" })], manifests("id"), "Secret")).toEqual({ ok: true, target: BY_ID });
  });

  it.each([
    ["armored", { armor: true }],
    ["another tool", { tool: "gpg" }],
    ["a container that does not fit the naming", { container: "tar" }],
  ])("is not a vault with %s", (_name, over) => {
    expect(checkEncryptedVault([vault()], manifests("plain", over), "Secret")).toEqual({ ok: false, reason: "unsupported_vault" });
  });

  it("says which way a vault is not one", () => {
    expect(checkEncryptedVault([vault()], manifests("plain"), "Nope")).toEqual({ ok: false, reason: "unknown_vault" });
    expect(checkEncryptedVault([vault({ encrypted: false, suffix: null })], manifests("plain"), "Secret")).toEqual({ ok: false, reason: "not_encrypted" });
    expect(checkEncryptedVault([vault({ manifestError: "bad" })], manifests("plain"), "Secret")).toEqual({ ok: false, reason: "unsupported_vault" });
    expect(checkEncryptedVault([vault()], {}, "Secret")).toEqual({ ok: false, reason: "unsupported_vault" });
    expect(checkEncryptedVault([vault({ fileNaming: "other" })], manifests("plain"), "Secret")).toEqual({ ok: false, reason: "unsupported_vault" });
  });
});
