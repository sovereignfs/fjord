import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import { newRecipients } from "../working/test-ciphertext";
import { runMigrations } from "../db/migrate";
import { freshDatabase } from "../db/test-support";
import { WorkingCopyService } from "../working/service";
import { createFile } from "./create";
import { deletePath } from "./delete";
import { DeletionService } from "./deletions";
import { restoreDeleted } from "./restore";
import { createEncryptedFile } from "./create-encrypted";
import { newEncryptedFile } from "../keys/files";
import type { CryptoModule } from "../keys/module";
import { createRequire } from "node:module";
import { wasmDirectory } from "../format/wasm";
import { movePath } from "./move";

/**
 * The acceptance of ROADMAP 1b.7: what the web client creates is held to what the CLI says. The repository the files were
 * made in is checked out and the real `fjord verify --strict` is run over it. The CLI is the format's reference
 * implementation, so a note or a document it accepts is one every other client will.
 *
 * It needs the CLI: set `FJORD_CLI` to the binary (`cargo build -p fjord-cli`, then `target/debug/fjord`). CI sets it for
 * one leg. Where it is not set these are skipped with a note; where it is set and is not there, that is a failure.
 */
const cli = process.env.FJORD_CLI;
if (cli && !existsSync(cli)) throw new Error(`FJORD_CLI is ${cli}, which is not there: run cargo build -p fjord-cli`);
if (!cli) console.warn("[fjord] CLI verification skipped: FJORD_CLI is not set (cargo build -p fjord-cli)");
const enabled = Boolean(cli) && wasmAvailable();

const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const AUTHOR = { name: "Ada Lovelace", email: "ada@example.com" };
const GUARD = "*\n!*/\n!*.age\n!fjord.vault.json\n!recipients.txt\n!.gitignore\n";
const RECIPIENTS = enabled ? newRecipients() : "";
const secretVault = (id: string, name: string, naming: "plain" | "id") =>
  JSON.stringify({ fjord: 1, id, name, createdAt: "2026-10-16T09:34:00Z", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: naming === "id" ? "tar" : "none", armor: false }, fileNaming: naming });
const BASE_FILES = {
  "Locked/fjord.vault.json": secretVault("01jagc4k7pr9tbm3ykwx6zq2hw", "Locked", "plain"),
  "Locked/recipients.txt": RECIPIENTS,
  "Locked/.gitignore": GUARD,
  "Sealed/fjord.vault.json": secretVault("01jagc4k7pr9tbm3ykwx6zq2hy", "Sealed", "id"),
  "Sealed/recipients.txt": RECIPIENTS,
  "Sealed/.gitignore": GUARD,
  "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3md", name: "Notes", createdAt: "2026-10-16T09:34:00Z", vaults: [{ path: "Notes", id: "01jagc4k7pr9tbm3ykwx6zq2hv" }, { path: "Locked", id: "01jagc4k7pr9tbm3ykwx6zq2hw" }, { path: "Sealed", id: "01jagc4k7pr9tbm3ykwx6zq2hy" }] }),
  ".gitattributes": "*.age -merge\n",
  "Notes/fjord.vault.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pr9tbm3ykwx6zq2hv", name: "Notes", createdAt: "2026-10-16T09:34:00Z", encryption: null, fileNaming: "plain" }),
  "Notes/existing.md": "# Existing\n",
  "Notes/Projects/2026/plan.fj.md": "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\ntitle: Plan\ncreated: 2026-10-16T09:34:00Z\n---\n\n# Plan\n",
};

let h: Awaited<ReturnType<typeof githubHarness>>;
let fake: FakeGitHub;
let directory: string;

beforeEach(async () => {
  if (!enabled) return;
  h = await githubHarness();
  fake = h.fake;
  await h.seed(BASE_FILES);
  directory = mkdtempSync(join(tmpdir(), "fjord-cli-verify-"));
});
afterEach(async () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  await h?.close();
});

/** The documents the CLI counted in the plaintext vault (the encrypted ones are not readable to it). */
const notesDocs = (report: { vaults: { name?: string; path?: string; directory?: string; docs: number }[] }) => report.vaults.find((vault) => [vault.name, vault.path, vault.directory].includes("Notes"))!.docs;

/** The repository as it is on the branch, checked out, and what `fjord verify` says about it. */
async function verify(): Promise<{ status: number | null; report: { counts: { errors: number; warnings: number }; diagnostics: { code: string; path: string }[]; vaults: { name?: string; path?: string; directory?: string; docs: number }[] } }> {
  const root = join(directory, `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const head = (await fake.branchHead())!;
  for (const path of Object.keys(await fake.filesAt(head))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), await fake.fileBytesAt(head, path)); // bytes: an encrypted file is not text
  }
  const run = spawnSync(cli as string, ["verify", "--json", "--strict", "--no-input", "-C", root], { encoding: "utf8" });
  return { status: run.status, report: JSON.parse(run.stdout) };
}

const make = (input: Partial<Parameters<typeof createFile>[1]>) =>
  createFile({ provider: h.provider, ref: h.repo, branch: "main", format: fjord() }, { vault: "Notes", folder: "", kind: "note", title: "", localMinute: WHEN, author: AUTHOR, ...input });

describe.skipIf(!enabled)("what the web creates, as the CLI sees it", () => {
  it("starts from a repository the CLI accepts, so that what follows is about what was made", async () => {
    const { status, report } = await verify();
    expect({ status, errors: report.counts.errors, warnings: report.counts.warnings, diagnostics: report.diagnostics }).toEqual({ status: 0, errors: 0, warnings: 0, diagnostics: [] });
  });

  it("accepts every kind of note and document it makes: titled, untitled, numbered, Unicode, long, nested", async () => {
    const before = notesDocs((await verify()).report);
    const made = [
      await make({ title: "Weekly review: what went well?" }),
      await make({ title: "" }),
      await make({ title: "" }), // the same minute: numbered
      await make({ title: "existing" }), // the name of a note that is there, case aside: numbered
      await make({ title: "日本語のノート — 🌊" }),
      await make({ title: "word ".repeat(40).trim() }), // cut at 60 characters
      await make({ title: "CON" }), // a name Windows reserves
      await make({ folder: "Projects/2026", title: "Todo" }),
      await make({ kind: "document", title: "Q4: plan \"final\"" }),
      await make({ kind: "document", title: "Q4: plan \"final\"" }), // numbered
      await make({ kind: "document", title: "日本語の文書" }),
      await make({ kind: "document", folder: "Projects/2026", title: "plan" }), // a document next to one called Plan, case aside
      await make({ kind: "document", title: "- [ ] # a title with markers" }),
      await make({ kind: "document", title: "x".repeat(200) }),
    ];
    expect(made.every((result) => result.ok), JSON.stringify(made.filter((result) => !result.ok))).toBe(true);

    const { status, report } = await verify();
    expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
    // The CLI counted the documents it found (a note with no header is not one); the web's own are among them.
    expect(notesDocs(report)).toBe(before + made.filter((result) => result.ok && result.path.endsWith(".fj.md")).length);
  });

  it("accepts what renaming and moving leave: the same documents with the same ids, in their new places", async () => {
    const before = notesDocs((await verify()).report);
    const common = { provider: h.provider, ref: h.repo, branch: "main", format: fjord(), drafts: { paths: async () => [] as string[] }, saveDraft: async () => ({ ok: false as const, reason: "unavailable" as const }) };
    const author = { name: "Ada Lovelace", email: "ada@example.com" };
    const files = await fake.filesAt((await fake.branchHead())!);
    expect(files["Notes/Projects/2026/plan.fj.md"]).toBeDefined();

    const folder = await movePath(common, { connectionId: 1, vault: "Notes", target: { type: "folder", path: "Notes/Projects", files: 1 }, destination: "Notes/Archive/Old projects", author });
    expect(folder.ok, JSON.stringify(folder)).toBe(true);
    const renamed = await movePath(common, { connectionId: 1, vault: "Notes", target: { type: "file", path: "Notes/existing.md", blob: (await h.provider.listDirectory(h.repo, (await fake.branchHead())!, "Notes")).find((entry) => entry.path === "Notes/existing.md")!.id }, destination: "Notes/Existing renamed.md", author });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);

    const { status, report } = await verify();
    expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
    expect(notesDocs(report)).toBe(before);
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/Archive/Old projects/2026/plan.fj.md"]).toBe(files["Notes/Projects/2026/plan.fj.md"]);
  });

  it("is able to fail: a document with a broken header is reported", async () => {
    await fake.commitFiles({ "Notes/Bad.fj.md": "---\nid: not-an-id\ntitle: T\n---\n" });
    const { status, report } = await verify();
    expect(status).not.toBe(0);
    expect(report.diagnostics.some((diagnostic) => diagnostic.path === "Notes/Bad.fj.md")).toBe(true);
  });
});

const module = enabled ? (createRequire(import.meta.url)(`${wasmDirectory()}/fjord_wasm.js`) as CryptoModule) : undefined;

describe.skipIf(!enabled)("what the web creates in an encrypted vault, as the CLI sees it (ROADMAP 2b.4)", () => {
  /** What the browser would send: the file written and encrypted to the vault's recipients, then committed by the server's rules. */
  async function makeSecret(naming: "plain" | "id", input: { kind?: "note" | "document"; title?: string; folder?: string }) {
    const kind = input.kind ?? "note";
    const title = input.title ?? "";
    const sealed = newEncryptedFile(module!, { kind, title, naming, recipients: RECIPIENTS, when: WHEN, now: 1_800_000_000_000, random: crypto.getRandomValues(new Uint8Array(16)) });
    if (!sealed.ok) throw new Error("the title could not name a file");
    return createEncryptedFile(
      { provider: h.provider, ref: h.repo, branch: "main", format: fjord() },
      { vault: naming === "plain" ? "Locked" : "Sealed", folder: input.folder ?? "", target: { naming, suffix: ".age" }, kind, title: naming === "plain" ? title : "", localMinute: WHEN, ciphertext: Uint8Array.from(Buffer.from(sealed.ciphertext, "base64")), author: AUTHOR },
    );
  }

  it("starts from a repository with two encrypted vaults the CLI accepts", async () => {
    const { status, report } = await verify();
    expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
  });

  it("accepts every note and document it makes in a plain-named vault, and in an id-named one", async () => {
    const made = [
      await makeSecret("plain", { title: "Weekly review: what went well?" }),
      await makeSecret("plain", { title: "" }),
      await makeSecret("plain", { title: "" }),
      await makeSecret("plain", { kind: "document", title: "Q4: plan \"final\"" }),
      await makeSecret("plain", { kind: "document", title: "Q4: plan \"final\"" }),
      await makeSecret("plain", { title: "日本語のノート — 🌊" }),
      await makeSecret("id", { title: "" }),
      await makeSecret("id", { kind: "document", title: "Q4 plan" }),
      await makeSecret("id", { kind: "document", title: "Q4 plan" }),
    ];
    expect(made.every((result) => result.ok), JSON.stringify(made.filter((result) => !result.ok))).toBe(true);
    const { status, report } = await verify();
    expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
  });
});

const haveAge = !spawnSync("age-keygen", ["--help"]).error; // the real age, which CI installs for the cross-checks

describe.skipIf(!enabled || !haveAge)("what the web renames, moves, deletes and restores in an encrypted vault, as the CLI and age see it (ROADMAP 2b.5)", () => {
  /** A real age identity: the file it is in, and its public key. */
  function identity() {
    const file = join(directory, "identity.txt");
    const made = spawnSync("age-keygen", ["-o", file], { encoding: "utf8" });
    const recipient = /public key: (age1\w+)/i.exec(`${made.stdout}${made.stderr}`)![1]!;
    return { file, recipient: `${recipient}\n` };
  }
  const deps = () => ({ provider: h.provider, ref: h.repo, branch: "main", format: fjord() });
  const make = async (vault: "Locked" | "Sealed", recipients: string, input: { kind: "note" | "document"; title: string; folder?: string }) => {
    const naming = vault === "Locked" ? "plain" : "id";
    const sealed = newEncryptedFile(module!, { ...input, naming, recipients, when: WHEN, now: 1_800_000_000_000, random: crypto.getRandomValues(new Uint8Array(16)) });
    if (!sealed.ok) throw new Error("bad title");
    const made = await createEncryptedFile(deps(), { vault, folder: input.folder ?? "", target: { naming, suffix: ".age" }, kind: input.kind, title: naming === "plain" ? input.title : "", localMinute: WHEN, ciphertext: Uint8Array.from(Buffer.from(sealed.ciphertext, "base64")), author: AUTHOR });
    if (!made.ok) throw new Error(`could not make: ${made.reason}`);
    return made.path;
  };
  const target = async (path: string) => ({ type: "file" as const, path, blob: (await h.provider.listDirectory(h.repo, (await fake.branchHead())!, path.slice(0, path.lastIndexOf("/")))).find((entry) => entry.path === path)!.id });
  const move = async (vault: string, path: string, destination: string, idNamed: boolean) => {
    const result = await movePath({ ...deps(), drafts: { paths: async () => [] as string[] }, saveDraft: async () => ({ ok: false as const, reason: "unavailable" as const }) }, { connectionId: 1, vault, target: await target(path), destination, author: AUTHOR, encrypted: { idNamed } });
    if (!result.ok) throw new Error(`could not move: ${result.reason}`);
  };
  const decrypt = async (key: string, path: string) => {
    const file = join(directory, `payload-${Math.random().toString(36).slice(2)}.age`);
    writeFileSync(file, await fake.fileBytesAt((await fake.branchHead())!, path));
    const run = spawnSync("age", ["-d", "-i", key, file]);
    expect(run.status, `age -d ${path}: ${run.stderr}`).toBe(0);
    return run.stdout;
  };

  it("leaves a repository that verifies, and whose files the real age still opens, in both namings", async () => {
    const { file: key, recipient } = identity();
    const note = await make("Locked", recipient, { kind: "note", title: "Plan" });
    const doc = await make("Locked", recipient, { kind: "document", title: "Budget" });
    const sealed = await make("Sealed", recipient, { kind: "document", title: "Hidden plan" });
    const other = await make("Sealed", recipient, { kind: "note", title: "Other" });

    await move("Locked", note, "Locked/Plan v2.md.age", false); // a rename
    await move("Locked", doc, "Locked/Archive/Budget.fj.md.age", false); // a move into a new folder
    await move("Sealed", sealed, `Sealed/Archive/${sealed.split("/").pop()}`, true); // an id-named file moves by its identifier
    // A delete and an Undo, of an id-named vault's file: the same bytes come back under the same identifier.
    const { database } = await freshDatabase();
    try {
      await runMigrations(database);
      const deletions = new DeletionService(database);
      const gone = await deletePath({ ...deps(), deletions, drafts: new WorkingCopyService(database), saveDraft: async () => ({ ok: false as const, reason: "unavailable" as const }) }, { connectionId: 1, accountId: "ada", vault: "Sealed", target: await target(other), kindOf: () => "other", author: AUTHOR });
      if (!gone.ok) throw new Error(`could not delete: ${gone.reason}`);
      expect(Object.keys(await fake.filesAt((await fake.branchHead())!))).not.toContain(other);
      const back = await restoreDeleted({ ...deps(), deletions, vaultOk: (vault) => vault === "Sealed", idNamed: () => true, windowMs: 1e12 }, { connectionId: 1, ids: gone.deletions, path: undefined, author: AUTHOR });
      expect(back.ok, JSON.stringify(back)).toBe(true);
    } finally {
      await database.close();
    }

    const { status, report } = await verify();
    expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });

    // age -d recovers each file, with no help from fjord.
    expect(new TextDecoder().decode(await decrypt(key, "Locked/Plan v2.md.age"))).toBe("# Plan\n");
    expect(new TextDecoder().decode(await decrypt(key, "Locked/Archive/Budget.fj.md.age"))).toContain("title: Budget");
    const container = await decrypt(key, `Sealed/Archive/${sealed.split("/").pop()}`);
    const names = spawnSync("tar", ["-tf", "-"], { input: container, encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    expect(names.stdout.trim()).toBe("Hidden plan.fj.md"); // `age -d | tar -x` gives the real name
    expect(new TextDecoder().decode(spawnSync("tar", ["-xOf", "-"], { input: await decrypt(key, other), env: { ...process.env, COPYFILE_DISABLE: "1" } }).stdout)).toBe("# Other\n");
  });
});
