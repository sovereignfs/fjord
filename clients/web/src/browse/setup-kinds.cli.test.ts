import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fjord, wasmAvailable } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { type SetupChoice, type SetupDeps, applySetup, changeKind } from "./setup";
import { createPost } from "../site/posts";
import { TreeCache } from "./tree-cache";
import { freshDatabase } from "../db/test-support";
import { runMigrations } from "../db/migrate";
import type { Database } from "../db/client";

/**
 * Each kind set up in the browser is held to the CLI (ROADMAP 3a.3): the repository it leaves is checked out and the real
 * `fjord verify --strict` is run over it, which must find nothing and report the kind. Needs `FJORD_CLI`, as `add-vault.cli.test.ts`.
 */
const cli = process.env.FJORD_CLI;
if (cli && !existsSync(cli)) throw new Error(`FJORD_CLI is ${cli}, which is not there: run cargo build -p fjord-cli`);
const enabled = Boolean(cli) && wasmAvailable();

const REF: RepositoryRef = { owner: "acme", name: "mine" };
const KEY = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const MINE: Record<string, string> = { "README.md": "# Mine\n", "notes.txt": "kept\n" };

const CASES: { name: string; choice: SetupChoice; kind: string }[] = [
  { name: "a drive", choice: { kind: "drive", vault: "Notes" }, kind: "drive" },
  { name: "a plaintext journal", choice: { kind: "journal", vault: "journal", encrypted: false, recipients: [] }, kind: "journal" },
  { name: "an encrypted journal", choice: { kind: "journal", vault: "journal", encrypted: true, recipients: [KEY] }, kind: "journal" },
  { name: "an Astro site", choice: { kind: "ssg", engine: "astro" }, kind: "ssg" },
  { name: "a Jekyll site", choice: { kind: "ssg", engine: "jekyll" }, kind: "ssg" },
];

let directory: string;
let database: Database;
beforeEach(async () => {
  if (!enabled) return;
  directory = mkdtempSync(join(tmpdir(), "fjord-setup-kinds-"));
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterEach(async () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  await database?.close();
});

async function filesOf(host: MemoryProvider): Promise<Record<string, string>> {
  const head = await host.getHead(REF, "main");
  if (!head.changed) throw new Error("no head");
  const tree = await host.getTree(REF, head.head.commit);
  const files: Record<string, string> = {};
  for (const entry of tree.entries.filter((candidate) => candidate.kind === "file")) files[entry.path] = new TextDecoder().decode(await host.readBlob(REF, entry.id));
  return files;
}

function verify(name: string, files: Record<string, string>) {
  const root = join(directory, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const run = spawnSync(cli as string, ["verify", "--json", "--strict", "-C", root, "--no-input"], { encoding: "utf8" });
  return { status: run.status, report: JSON.parse(run.stdout) as { repositoryKind: string; diagnostics: unknown[] } };
}

describe.skipIf(!enabled)("a repository set up as a kind in the browser, as the CLI sees it", () => {
  const deps = (host: MemoryProvider): SetupDeps => ({ provider: host, cache: new TreeCache(database), format: fjord(), now: () => 1_793_000_000_000, random: () => Uint8Array.from({ length: 80 }, (_, i) => i + 1) });

  for (const { name, choice, kind } of CASES) {
    it(`${name}: the CLI verifies it strictly, and reads its kind`, async () => {
      const host = new MemoryProvider();
      host.createRepository(REF, { canPush: true });
      host.seed(REF, MINE);
      await applySetup(deps(host), { id: 1, ref: REF, branch: "main", repositoryName: "mine" }, choice);
      const { status, report } = verify(name.replaceAll(" ", "-"), await filesOf(host));
      expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
      expect(report.repositoryKind).toBe(kind);
    });
  }

  it("a drive changed to a journal: the CLI reads the new kind and finds nothing wrong", async () => {
    const host = new MemoryProvider();
    host.createRepository(REF, { canPush: true });
    host.seed(REF, MINE);
    await applySetup(deps(host), { id: 1, ref: REF, branch: "main", repositoryName: "mine" }, "Notes");
    await changeKind(deps(host), { id: 1, ref: REF, branch: "main" }, { kind: "journal" });
    const { status, report } = verify("changed", await filesOf(host));
    expect({ status, diagnostics: report.diagnostics, kind: report.repositoryKind }).toEqual({ status: 0, diagnostics: [], kind: "journal" });
  });

  for (const engine of ["astro", "jekyll"] as const) {
    it(`${engine}: a post made in the browser passes the real fjord verify --strict, in a site set up in the browser`, async () => {
      const host = new MemoryProvider();
      host.createRepository(REF, { canPush: true });
      host.seed(REF, MINE);
      await applySetup(deps(host), { id: 1, ref: REF, branch: "main", repositoryName: "mine" }, { kind: "ssg", engine });
      const AT = 1_793_561_400_000;
      for (const [title, draft] of [["Hello", false], ["Later", true]] as const) {
        const made = await createPost({ provider: host, ref: REF, branch: "main", format: fjord() }, { vault: "content", engine, at: AT, offsetMinutes: 330, title, draft, author: { name: "A", email: "a@example.com" } });
        expect(made.ok).toBe(true);
      }
      const { status, report } = verify(`post-${engine}`, await filesOf(host));
      expect({ status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
    });
  }
});

