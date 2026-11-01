import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import type { Identity } from "../providers/types";
import { encryptedDraft } from "../working/test-ciphertext";
import { type TransferResult, type VaultForm, transferFile, transferMessage } from "./transfer";

/**
 * Moving a file between vaults, one of them encrypted (ROADMAP 2b.6), against a GitHub whose storage is a real git repository. The server has no key: the bytes for the
 * destination are made by the browser. What is asserted is what git says about the commit (one file away, one file in, nothing else), and the rules that keep plaintext
 * out of an encrypted vault whatever was sent.
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;

const ADA: Identity = { name: "Ada Lovelace", email: "ada@example.com" };
const manifest = (name: string, naming: "plain" | "id" | null) =>
  JSON.stringify(
    naming === null
      ? { fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name, createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" }
      : { fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hw", name, createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: naming === "id" ? "tar" : "none", armor: false }, fileNaming: naming },
  );
const PLAINTEXT: VaultForm = { form: "plaintext" };
const PLAIN: VaultForm = { form: "encrypted", naming: "plain" };
const BY_ID: VaultForm = { form: "encrypted", naming: "id" };
const ID = "01jagc4k7pr9tbm3ykwx6zq2hz";
const NEW_ID = "01jagc4k7pr9tbm3ykwx6zq2hy";

beforeEach(async () => {
  if (!available) return;
  h = await githubHarness();
  fake = h.fake;
});
afterEach(async () => h?.close());

const seed = (files: Record<string, string | Buffer> = {}) =>
  h.seed({ "Notes/fjord.vault.json": manifest("Notes", null), "Locked/fjord.vault.json": manifest("Locked", "plain"), "Sealed/fjord.vault.json": manifest("Sealed", "id"), "Locked/recipients.txt": "age1x\n", "Sealed/recipients.txt": "age1x\n", ...files });
const blobOf = async (path: string) => {
  const head = await h.provider.getHead(h.repo, "main");
  if (!head.changed) throw new Error("no head");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return (await h.provider.listDirectory(h.repo, head.head.commit, dir)).find((entry) => entry.path === path)!.id;
};
const move = async (input: { from: string; fromForm: VaultForm; to: string; toForm: VaultForm; content: Uint8Array; blob?: string }, drafts: string[] = []): Promise<TransferResult> =>
  transferFile(
    { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), drafts: { paths: async () => drafts } },
    { connectionId: 1, source: { path: input.from, blob: input.blob ?? (await blobOf(input.from)), form: input.fromForm }, destination: { path: input.to, form: input.toForm }, content: input.content, author: ADA },
  );
const reason = (result: TransferResult) => (result.ok ? "ok" : result.reason);
const noPlaintext = async (commit: string, vault: string) => {
  for (const [name, text] of Object.entries(await fake.filesAt(commit))) if (name.startsWith(`${vault}/`)) expect(text, name).not.toContain("SECRET PLAINTEXT");
};

describe("a commit's message", () => {
  it("names nothing that is secret", () => {
    expect(transferMessage({ path: "Notes/Plan.md", form: PLAINTEXT }, { path: "Locked/Plan.md.age", form: PLAIN })).toBe("Move Plan into the encrypted vault Locked");
    expect(transferMessage({ path: `Sealed/${ID}.age`, form: BY_ID }, { path: "Notes/Real name.md", form: PLAINTEXT })).toBe("Move a file out of the encrypted vault Sealed");
    expect(transferMessage({ path: "Locked/Plan.md.age", form: PLAIN }, { path: `Sealed/${NEW_ID}.age`, form: BY_ID })).toBe("Move Plan from Locked to Sealed");
    expect(transferMessage({ path: `Sealed/${ID}.age`, form: BY_ID }, { path: "Locked/Real name.md.age", form: PLAIN })).toBe("Move a file from Sealed to Locked");
  });
});

describe.skipIf(!available)("a file moved into an encrypted vault", () => {
  it("is one commit that takes the plaintext away and adds the ciphertext, and the new commit has no plaintext of it", async () => {
    const before = await seed({ "Notes/Plan.md": "SECRET PLAINTEXT note", "Notes/other.md": "o" });
    const { bytes } = encryptedDraft("SECRET PLAINTEXT note");
    const result = await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: bytes });
    expect(result).toEqual({ ok: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), path: "Locked/Plan.md.age" });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(before);
    expect(await fake.show(commit, "%B")).toBe("Move Plan into the encrypted vault Locked");
    expect([...(await fake.fileBytesAt(commit, "Locked/Plan.md.age"))]).toEqual([...bytes]);
    const files = Object.keys(await fake.filesAt(commit)).sort();
    expect(files).toEqual(["Locked/Plan.md.age", "Locked/fjord.vault.json", "Locked/recipients.txt", "Notes/fjord.vault.json", "Notes/other.md", "Sealed/fjord.vault.json", "Sealed/recipients.txt"]);
    await noPlaintext(commit, "Locked");
    await fake.fsck();
  });

  it("goes into an id-named vault under a new identifier", async () => {
    await seed({ "Notes/Plan.md": "SECRET PLAINTEXT" });
    expect(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: `Sealed/${NEW_ID}.age`, toForm: BY_ID, content: encryptedDraft("x").bytes })).toMatchObject({ ok: true, path: `Sealed/${NEW_ID}.age` });
  });

  it("never puts plain text in an encrypted vault, whatever was sent", async () => {
    await seed({ "Notes/Plan.md": "SECRET PLAINTEXT" });
    const before = await fake.branchHead();
    const plain = new TextEncoder().encode("SECRET PLAINTEXT");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: plain }))).toBe("wrong_form");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: `Sealed/${NEW_ID}.age`, toForm: BY_ID, content: plain }))).toBe("wrong_form");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: new Uint8Array() }))).toBe("wrong_form");
    expect(await fake.branchHead()).toBe(before);
  });

  it("has the names of its vault: .age after the name, an identifier in an id-named vault", async () => {
    await seed({ "Notes/Plan.md": "x" });
    const { bytes } = encryptedDraft("x");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md", toForm: PLAIN, content: bytes }))).toBe("bad_path");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Sealed/Plan.age", toForm: BY_ID, content: bytes }))).toBe("bad_path");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/a:b.md.age", toForm: PLAIN, content: bytes }))).toBe("bad_path");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/fjord.vault.json", toForm: PLAIN, content: bytes }))).toBe("protected");
  });
});

describe.skipIf(!available)("a file moved out of an encrypted vault", () => {
  it("is one commit that takes the ciphertext away and adds the text, and only a .md goes into a plaintext vault", async () => {
    const note = encryptedDraft("SECRET PLAINTEXT");
    const before = await seed({ "Locked/Plan.md.age": Buffer.from(note.bytes) });
    const text = new TextEncoder().encode("SECRET PLAINTEXT");
    expect(reason(await move({ from: "Locked/Plan.md.age", fromForm: PLAIN, to: "Notes/Plan.txt", toForm: PLAINTEXT, content: text }))).toBe("bad_path");
    const result = await move({ from: "Locked/Plan.md.age", fromForm: PLAIN, to: "Notes/Plan.md", toForm: PLAINTEXT, content: text });
    expect(result).toMatchObject({ ok: true, path: "Notes/Plan.md" });
    const commit = (result as { commit: string }).commit;
    expect(await fake.show(commit, "%P")).toBe(before);
    expect((await fake.filesAt(commit))["Notes/Plan.md"]).toBe("SECRET PLAINTEXT");
    expect(Object.keys(await fake.filesAt(commit))).not.toContain("Locked/Plan.md.age");
    expect(await fake.show(commit, "%B")).toBe("Move Plan out of the encrypted vault Locked");
  });

  it("does not put ciphertext in a plaintext vault, nor binary", async () => {
    await seed({ "Locked/Plan.md.age": Buffer.from(encryptedDraft("x").bytes) });
    expect(reason(await move({ from: "Locked/Plan.md.age", fromForm: PLAIN, to: "Notes/Plan.md", toForm: PLAINTEXT, content: encryptedDraft("y").bytes }))).toBe("wrong_form");
    expect(reason(await move({ from: "Locked/Plan.md.age", fromForm: PLAIN, to: "Notes/Plan.md", toForm: PLAINTEXT, content: new Uint8Array([97, 0, 98]) }))).toBe("wrong_form");
  });

  it("takes the file of an id-named vault to a plaintext vault under the name the browser found inside it", async () => {
    await seed({ [`Sealed/${ID}.age`]: Buffer.from(encryptedDraft("x").bytes) });
    const result = await move({ from: `Sealed/${ID}.age`, fromForm: BY_ID, to: "Notes/Real name.md", toForm: PLAINTEXT, content: new TextEncoder().encode("x") });
    expect(result).toMatchObject({ ok: true });
    expect(await fake.show((result as { commit: string }).commit, "%B")).toBe("Move a file out of the encrypted vault Sealed");
  });
});

describe.skipIf(!available)("a file moved between encrypted vaults", () => {
  it("takes the file to the other vault's form, ciphertext both ways", async () => {
    await seed({ "Locked/Plan.md.age": Buffer.from(encryptedDraft("x").bytes) });
    const { bytes } = encryptedDraft("x");
    const result = await move({ from: "Locked/Plan.md.age", fromForm: PLAIN, to: `Sealed/${NEW_ID}.age`, toForm: BY_ID, content: bytes });
    expect(result).toMatchObject({ ok: true });
    expect([...(await fake.fileBytesAt((result as { commit: string }).commit, `Sealed/${NEW_ID}.age`))]).toEqual([...bytes]);
  });
});

describe.skipIf(!available)("what is never done", () => {
  it("goes over nothing, and moves only the version that was shown", async () => {
    await seed({ "Notes/Plan.md": "SECRET PLAINTEXT", "Locked/Plan.md.age": "x" });
    const before = await fake.branchHead();
    const { bytes } = encryptedDraft("x");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: bytes }))).toBe("path_taken");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/PLAN.md.age", toForm: PLAIN, content: bytes }))).toBe("path_taken");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/New.md.age", toForm: PLAIN, content: bytes, blob: "0".repeat(40) }))).toBe("upstream_changed");
    expect(reason(await move({ from: "Notes/Missing.md", fromForm: PLAINTEXT, to: "Locked/New.md.age", toForm: PLAIN, content: bytes, blob: "0".repeat(40) }))).toBe("gone");
    expect(await fake.branchHead()).toBe(before);
  });

  it("does not move a file that has unsaved changes, or into a place that has", async () => {
    await seed({ "Notes/Plan.md": "x" });
    const { bytes } = encryptedDraft("x");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: bytes }, ["Notes/Plan.md"]))).toBe("has_drafts");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Locked/Plan.md.age", toForm: PLAIN, content: bytes }, ["Locked/Plan.md.age"]))).toBe("has_drafts");
  });

  it("is not for one vault, nor for two plaintext ones, which Move does", async () => {
    await seed({ "Notes/Plan.md": "x" });
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Notes/Plan 2.md", toForm: PLAINTEXT, content: new Uint8Array([120]) }))).toBe("same_vault");
    expect(reason(await move({ from: "Notes/Plan.md", fromForm: PLAINTEXT, to: "Other/Plan.md", toForm: PLAINTEXT, content: new Uint8Array([120]) }))).toBe("wrong_form");
  });
});
