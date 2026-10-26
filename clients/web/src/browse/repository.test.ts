import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { forgetBlobTexts } from "./blob-text";
import { readRepository } from "./repository";
import { KEEP_COMMITS, TreeCache } from "./tree-cache";

/**
 * Reading a repository's vaults from a git host (ROADMAP 1a.11): that it matches what `fjord ls` says about every
 * conformance fixture, that it reads only what it must (the head, the tree once per commit, the vault manifests,
 * never a document), and that a very large repository's cut-short listing is handled. The host here is the
 * in-memory provider, the format is the real module, and the cache is on whichever database the leg runs on.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const fixtures = join(process.cwd(), "..", "..", "tests", "fixtures");
const golden = JSON.parse(readFileSync(join(fixtures, "discovery.json"), "utf8")) as Record<
  string,
  {
    discover: "error" | { directory: string; label: string | null; encrypted: boolean; suffix: string; contents: { relative: string; logical: string; is_payload: boolean; size: number }[] }[];
    verify: { nested: string[] };
  }
>;

const REF: RepositoryRef = { owner: "acme", name: "fixture" };
const CONNECTION = { id: 7, ref: REF, branch: "main" };

let database: Database;
const cacheTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);
const rows = async (connection = CONNECTION.id) => dbAll<{ commitId: string }>(database, sql`SELECT commit_id AS "commitId" FROM ${cacheTable()} WHERE connection_id = ${connection}`);

beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
});

/** A repository on the in-memory host holding exactly what a fixture directory holds. */
function hostOf(fixture: string): MemoryProvider {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!lstatSync(path).isSymbolicLink()) files[relative(join(fixtures, fixture), path).split("\\").join("/")] = readFileSync(path);
    }
  };
  walk(join(fixtures, fixture));
  return hostWith(files);
}

function hostWith(files: Record<string, string | Uint8Array>): MemoryProvider {
  const host = new MemoryProvider();
  host.createRepository(REF);
  host.seed(REF, files);
  return host;
}

const deps = (host: MemoryProvider) => ({ provider: host, cache: new TreeCache(database), format: fjord() });

describe.skipIf(!available)(`reading a repository's vaults (${leg})`, () => {
  for (const [name, expected] of Object.entries(golden)) {
    it(`${name}: finds what the filesystem walk found`, async () => {
      const read = await readRepository(deps(hostOf(name)), CONNECTION);
      expect(read.discovery.nested).toEqual(expected.verify.nested);
      expect(read.partial).toBe(false);

      if (expected.discover === "error") {
        expect(read.discovery.vaults.some((vault) => vault.manifestError !== null)).toBe(true);
        return;
      }
      const wanted = expected.discover;
      expect(read.discovery.vaults.map((vault) => vault.directory)).toEqual(wanted.map((vault) => vault.directory));
      read.discovery.vaults.forEach((vault, index) => {
        const want = wanted[index]!;
        expect([vault.name, vault.encrypted, vault.suffix]).toEqual([want.label, want.encrypted, want.suffix]);
        expect(vault.files.map((file) => [file.relative, file.logical, file.kind === "payload", file.size])).toEqual(
          want.contents.map((content) => [content.relative, content.logical, content.is_payload, content.size]),
        );
      });
    });
  }

  it("tells the documents from the notes in a vault, by name", async () => {
    const read = await readRepository(deps(hostOf("documents")), CONNECTION);
    expect(read.discovery.vaults[0]!.files.map((file) => [file.relative, file.kind])).toEqual([
      ["idea.md", "note"],
      ["plan.fj.md", "document"],
    ]);
  });

  it("reads the repository manifest when there is one, and carries on when there is not", async () => {
    const withManifest = await readRepository(deps(hostOf("conforming")), CONNECTION);
    expect(withManifest.manifest).toMatchObject({ ok: true, version: 1 });

    // Vaults come from the listing, which is the authority; `fjord.json` is a convenience (spec §2.1).
    const without = await readRepository(deps(hostWith({ "Notes/fjord.vault.json": '{"name":"Notes","encryption":null}', "Notes/a.md": "# a\n" })), CONNECTION);
    expect(without.manifest).toBeNull();
    expect(without.discovery.vaults.map((vault) => vault.directory)).toEqual(["Notes"]);

    const broken = await readRepository(deps(hostWith({ "fjord.json": "not json", "Notes/fjord.vault.json": '{"name":"Notes","encryption":null}' })), CONNECTION);
    expect(broken.manifest).toMatchObject({ ok: false });
  });

  describe("what it asks the host for", () => {
    it("reads the head, the tree and the manifests, and never a document", async () => {
      const host = hostOf("conforming");
      const readBlob = vi.spyOn(host, "readBlob");
      const getTree = vi.spyOn(host, "getTree");
      const read = await readRepository(deps(host), CONNECTION);

      expect(getTree).toHaveBeenCalledTimes(1);
      const asked = readBlob.mock.calls.map((call) => call[1]).sort();
      const manifests = ["fjord.json", "Private/fjord.vault.json", "Public/fjord.vault.json"].map((path) => read.blobs.get(path)!).sort();
      expect(asked).toEqual(manifests);
      // `Public/welcome.md` is in the listing and was not read.
      expect(asked).not.toContain(read.blobs.get("Public/welcome.md"));
    });

    it("reads a commit's tree once, and its manifests once, however often it is looked at", async () => {
      const host = hostOf("conforming");
      const getTree = vi.spyOn(host, "getTree");
      const readBlob = vi.spyOn(host, "readBlob");
      const dependencies = deps(host);
      const first = await readRepository(dependencies, CONNECTION);
      const treesAfterFirst = getTree.mock.calls.length;
      const blobsAfterFirst = readBlob.mock.calls.length;

      const second = await readRepository(dependencies, CONNECTION);
      expect(getTree.mock.calls.length).toBe(treesAfterFirst);
      expect(readBlob.mock.calls.length).toBe(blobsAfterFirst);
      expect(second.discovery).toEqual(first.discovery);
      expect(second.commit).toBe(first.commit);
    });

    it("reads the new tree when the branch has moved, and keeps only the latest few", async () => {
      const host = hostWith({ "V/fjord.vault.json": '{"name":"V","encryption":null}', "V/a.md": "a" });
      const getTree = vi.spyOn(host, "getTree");
      // A clock that moves between views, as a real one does: "the latest" is by when each was kept.
      let clock = 1_800_000_000_000;
      const dependencies = { ...deps(host), now: () => ++clock };
      const commits: string[] = [];
      for (let i = 0; i < KEEP_COMMITS + 2; i++) {
        host.seed(REF, { [`V/n${i}.md`]: `${i}` });
        commits.push((await readRepository(dependencies, CONNECTION)).commit);
      }
      expect(getTree).toHaveBeenCalledTimes(KEEP_COMMITS + 2);
      expect(new Set(commits).size).toBe(KEEP_COMMITS + 2);
      expect((await rows()).length).toBe(KEEP_COMMITS);
      // The newest are the ones kept.
      expect((await rows()).map((row) => row.commitId).sort()).toEqual(commits.slice(-KEEP_COMMITS).sort());
    });

    it("does not mix one connection's trees with another's", async () => {
      const host = hostOf("conforming");
      const dependencies = deps(host);
      await readRepository(dependencies, { ...CONNECTION, id: 1 });
      await readRepository(dependencies, { ...CONNECTION, id: 2 });
      expect((await rows(1)).length).toBe(1);
      expect((await rows(2)).length).toBe(1);
    });
  });

  describe("a repository too large for the host to list", () => {
    it("finds the vaults a directory at a time, and says it did not list what is in them", async () => {
      const host = hostOf("conforming");
      host.setTreeLimit(1);
      const getTree = vi.spyOn(host, "getTree");
      const listDirectory = vi.spyOn(host, "listDirectory");
      const read = await readRepository(deps(host), CONNECTION);

      expect(getTree).toHaveBeenCalledTimes(1);
      expect(read.partial).toBe(true);
      expect(read.discovery.vaults.map((vault) => vault.directory)).toEqual(["Private", "Public"]);
      expect(read.discovery.vaults.every((vault) => vault.files.length === 0 && vault.manifestError === null)).toBe(true);
      expect(read.manifest).toMatchObject({ ok: true });
      // The root, then each top-level directory: one request each.
      const asked = listDirectory.mock.calls.map((call) => call[2]).sort();
      expect(asked).toEqual(["", "Private", "Public"]);
    });

    it("is cached as incomplete, so a second look does not ask the host for the tree again", async () => {
      const host = hostOf("conforming");
      host.setTreeLimit(1);
      const getTree = vi.spyOn(host, "getTree");
      const dependencies = deps(host);
      await readRepository(dependencies, CONNECTION);
      const again = await readRepository(dependencies, CONNECTION);
      expect(getTree).toHaveBeenCalledTimes(1);
      expect(again.partial).toBe(true);
    });
  });

  it("does not read a manifest too large to be one, and says that vault cannot be read", async () => {
    const huge = "x".repeat(300 * 1024);
    const host = hostWith({ "Big/fjord.vault.json": huge, "Ok/fjord.vault.json": '{"name":"Ok","encryption":null}', "Ok/a.md": "a" });
    const read = await readRepository(deps(host), CONNECTION);
    const byDirectory = Object.fromEntries(read.discovery.vaults.map((vault) => [vault.directory, vault]));
    expect(byDirectory.Big!.manifestError).not.toBeNull();
    expect(byDirectory.Ok!.manifestError).toBeNull();
  });

  it("lets a host's refusal through as it is, for the page to explain", async () => {
    const host = hostOf("conforming");
    await expect(readRepository(deps(host), { ...CONNECTION, branch: "no-such-branch" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe(`the tree cache (${leg})`, () => {
  const tree = (commit: string, paths: string[], complete = true) => ({ commit, complete, entries: paths.map((path) => ({ path, kind: "file" as const, id: `id-${path}`, size: 3, executable: false })) });

  it("gives back what it was given, the complete flag included", async () => {
    const cache = new TreeCache(database);
    await cache.put(1, tree("c1", ["a.md", "b/c.md"], false));
    expect(await cache.get(1, "c1")).toEqual(tree("c1", ["a.md", "b/c.md"], false));
    expect(await cache.get(1, "other")).toBeUndefined();
    expect(await cache.get(2, "c1")).toBeUndefined();
  });

  it("keeps one row for a commit however often it is put", async () => {
    const cache = new TreeCache(database);
    await cache.put(1, tree("c1", ["a.md"]));
    await cache.put(1, tree("c1", ["a.md", "b.md"]));
    expect((await rows(1)).length).toBe(1);
    expect((await cache.get(1, "c1"))!.entries).toHaveLength(2);
  });

  it("forgets a connection's trees and no one else's", async () => {
    const cache = new TreeCache(database);
    await cache.put(1, tree("c1", ["a.md"]));
    await cache.put(2, tree("c1", ["a.md"]));
    await cache.forget(1);
    expect((await rows(1)).length).toBe(0);
    expect((await rows(2)).length).toBe(1);
  });
});
