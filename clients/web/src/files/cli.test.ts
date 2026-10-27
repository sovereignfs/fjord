import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable } from "../format/wasm";
import type { FakeGitHub } from "../providers/testing/fake-github";
import { githubHarness } from "../providers/testing/harnesses";
import { createFile } from "./create";
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
const BASE_FILES = {
  "fjord.json": JSON.stringify({ fjord: 1, id: "01jagc4k7pqw2xn8rvty5zb3md", name: "Notes", createdAt: "2026-10-16T09:34:00Z", vaults: [{ path: "Notes", id: "01jagc4k7pr9tbm3ykwx6zq2hv" }] }),
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

/** The repository as it is on the branch, checked out, and what `fjord verify` says about it. */
async function verify(): Promise<{ status: number | null; report: { counts: { errors: number; warnings: number }; diagnostics: { code: string; path: string }[]; vaults: { docs: number }[] } }> {
  const root = join(directory, `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [path, content] of Object.entries(await fake.filesAt((await fake.branchHead())!))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
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
    const before = (await verify()).report.vaults[0]!.docs;
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
    expect(report.vaults[0]!.docs).toBe(before + made.filter((result) => result.ok && result.path.endsWith(".fj.md")).length);
  });

  it("accepts what renaming and moving leave: the same documents with the same ids, in their new places", async () => {
    const before = (await verify()).report.vaults[0]!.docs;
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
    expect(report.vaults[0]!.docs).toBe(before);
    expect((await fake.filesAt((await fake.branchHead())!))["Notes/Archive/Old projects/2026/plan.fj.md"]).toBe(files["Notes/Projects/2026/plan.fj.md"]);
  });

  it("is able to fail: a document with a broken header is reported", async () => {
    await fake.commitFiles({ "Notes/Bad.fj.md": "---\nid: not-an-id\ntitle: T\n---\n" });
    const { status, report } = await verify();
    expect(status).not.toBe(0);
    expect(report.diagnostics.some((diagnostic) => diagnostic.path === "Notes/Bad.fj.md")).toBe(true);
  });
});
