import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultOptions } from "../format/types";
import { fjord, wasmAvailable } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { type AddVaultDeps, addVault } from "./add-vault";
import { TreeCache } from "./tree-cache";
import { freshDatabase } from "../db/test-support";
import { runMigrations } from "../db/migrate";
import type { Database } from "../db/client";

/**
 * A vault added in the browser is held to the CLI (ROADMAP 2d.1): the repository it leaves is checked out and the real
 * `fjord verify --strict` is run over it, and the files are the ones `fjord vault add` writes from the same planner, byte for byte
 * once the identifier and the time (which each run makes for itself) are put alike.
 *
 * It needs the CLI: set `FJORD_CLI` to the binary (`cargo build -p fjord-cli`, then `target/debug/fjord`). CI sets it for one leg.
 */
const cli = process.env.FJORD_CLI;
if (cli && !existsSync(cli)) throw new Error(`FJORD_CLI is ${cli}, which is not there: run cargo build -p fjord-cli`);
if (!cli) console.warn("[fjord] CLI verification of added vaults skipped: FJORD_CLI is not set (cargo build -p fjord-cli)");
const enabled = Boolean(cli) && wasmAvailable();

const REF: RepositoryRef = { owner: "acme", name: "notes" };
const KEY = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
const BASE: Record<string, string> = {
  "fjord.json": `${JSON.stringify({ fjord: 1, id: "01m4xrc0000c51260z4rpk8et2", name: "notes", createdAt: "2026-10-14T17:46:40Z", "x-custom": { keep: true }, vaults: [{ path: "Public", id: "01m4xrc000edx8324fjtet9axj" }] }, null, 2)}\n`,
  "Public/fjord.vault.json": JSON.stringify({ fjord: 1, id: "01m4xrc000edx8324fjtet9axj", name: "Public", createdAt: "2026-10-14T17:46:40Z", encryption: null, fileNaming: "plain" }),
  "Public/hello.md": "# Hello\n",
  ".gitattributes": "* text=auto\n",
};

const CASES: { name: string; options: VaultOptions }[] = [
  { name: "a plaintext vault", options: { name: "Journal", encrypted: false, idNaming: false, recipients: [] } },
  { name: "an encrypted vault", options: { name: "Secret", encrypted: true, idNaming: false, recipients: [KEY] } },
  { name: "an encrypted vault named by id", options: { name: "Sealed", encrypted: true, idNaming: true, recipients: [KEY] } },
];

let directory: string;
let database: Database;
beforeEach(async () => {
  if (!enabled) return;
  directory = mkdtempSync(join(tmpdir(), "fjord-add-vault-"));
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterEach(async () => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  await database?.close();
});

function checkout(name: string, files: Record<string, string>): string {
  const root = join(directory, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function viaWeb(options: VaultOptions, base: Record<string, string> = BASE): Promise<{ files: Record<string, string>; vaultId: string }> {
  const host = new MemoryProvider();
  host.createRepository(REF, { canPush: true });
  host.seed(REF, base);
  const deps: AddVaultDeps = { provider: host, cache: new TreeCache(database), format: fjord(), now: () => 1_793_000_000_000, random: () => Uint8Array.from({ length: 16 }, (_, i) => i + 1) };
  const done = await addVault(deps, { id: 1, ref: REF, branch: "main" }, options);
  const head = await host.getHead(REF, "main");
  if (!head.changed) throw new Error("no head");
  const tree = await host.getTree(REF, head.head.commit);
  const files: Record<string, string> = {};
  for (const entry of tree.entries.filter((candidate) => candidate.kind === "file")) files[entry.path] = new TextDecoder().decode(await host.readBlob(REF, entry.id));
  return { files, vaultId: done.vaultId };
}

const fjordCli = (...args: string[]) => spawnSync(cli as string, [...args, "--no-input"], { encoding: "utf8" });

describe.skipIf(!enabled)("a vault added in the browser, as the CLI sees it", () => {
  for (const { name, options } of CASES) {
    it(`${name}: the CLI verifies the repository it leaves, strictly`, async () => {
      // The repository must have the merge guard, and `verify` says so even of a repository with no encrypted vault: an encrypted vault is
      // added to one without it (and brings it), a plaintext vault to one that is otherwise right.
      const { files } = await viaWeb(options, options.encrypted ? BASE : { ...BASE, ".gitattributes": "* text=auto\n*.age binary -diff -merge\n" });
      const root = checkout("web", files);
      const run = fjordCli("verify", "--json", "--strict", "-C", root);
      const report = JSON.parse(run.stdout) as { counts: { errors: number; warnings: number }; diagnostics: unknown[]; vaults: unknown[] };
      expect({ status: run.status, diagnostics: report.diagnostics }).toEqual({ status: 0, diagnostics: [] });
      expect(report.vaults).toHaveLength(2);
    });

    it(`${name}: the files are those \`fjord vault add\` writes, byte for byte`, async () => {
      const web = await viaWeb(options);

      const root = checkout("cli", BASE);
      const args = ["vault", "add", options.name, "--json", "-C", root];
      if (options.encrypted) args.push("--encrypted");
      if (options.idNaming) args.push("--id-naming");
      for (const key of options.recipients) args.push("--recipient", key);
      const run = fjordCli(...args);
      expect(run.status, run.stderr).toBe(0);
      const made = JSON.parse(run.stdout) as { id: string };
      const createdAt = (JSON.parse(readFileSync(join(root, options.name, "fjord.vault.json"), "utf8")) as { createdAt: string }).createdAt;

      // The identifier and the time are each run's own: put the web's alike, then the text must be the same.
      const webCreated = (JSON.parse(web.files[`${options.name}/fjord.vault.json`] as string) as { createdAt: string }).createdAt;
      const alike = (text: string) => text.replaceAll(web.vaultId, made.id).replaceAll(webCreated, createdAt);
      const written = Object.keys(web.files).filter((path) => web.files[path] !== BASE[path]);
      expect(written.sort()).toEqual(
        ["fjord.json", `${options.name}/fjord.vault.json`, ...(options.encrypted ? [`${options.name}/recipients.txt`, `${options.name}/.gitignore`, ".gitattributes"] : [])].sort(),
      );
      for (const path of written) expect(alike(web.files[path] as string), path).toBe(readFileSync(join(root, path), "utf8"));
    });
  }
});
