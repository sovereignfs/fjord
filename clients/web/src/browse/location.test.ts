import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { dbRun } from "../db/exec";
import { runMigrations } from "../db/migrate";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { freshDatabase, testTarget } from "../db/test-support";
import { fjord, wasmAvailable, wasmDirectory } from "../format/wasm";
import { MemoryProvider } from "../providers/memory";
import type { RepositoryRef } from "../providers/types";
import { forgetBlobTexts } from "./blob-text";
import { type Location, locate, safeSegments } from "./location";
import { readRepository } from "./repository";
import { TreeCache } from "./tree-cache";

/**
 * Browsing inside a vault (ROADMAP 1a.11): which folders and files a path leads to, what each file is by its name, and that a
 * repository too large for the host to list reads the same, one directory at a time. The host is the in-memory provider and
 * the format is the real module.
 */
const { leg } = testTarget();
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const REF: RepositoryRef = { owner: "acme", name: "browse" };
const CONNECTION = { id: 3, ref: REF, branch: "main" };
const PLAIN = JSON.stringify({ name: "Notes", encryption: null, fileNaming: "plain" });
const SECRET = JSON.stringify({ name: "Secret", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "none", armor: false }, fileNaming: "plain" });
const BY_ID = JSON.stringify({ name: "ById", encryption: { tool: "age", recipients: "recipients.txt", suffix: ".age", container: "tar", armor: false }, fileNaming: "id" });

const LAYOUT: Record<string, string> = {
  "fjord.json": "{}",
  "V/fjord.vault.json": PLAIN,
  "V/a.md": "a",
  "V/Z.md": "z",
  "V/b.png": "b",
  "V/Q4/report.fj.md": "r",
  "V/Q4/deep/x.csv": "x",
  "V/Q4/deep/more/y.md": "y",
  "S/fjord.vault.json": SECRET,
  "S/recipients.txt": "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n",
  "S/note.md.age": "x",
  "S/Inner/deep.md.age": "x",
  "I/fjord.vault.json": BY_ID,
  "I/01jagc4k7pt8y3wqnmzv5xrb8j.age": "x",
};

let database: Database;
const cacheTable = () => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);
beforeAll(async () => {
  ({ database } = await freshDatabase());
  await runMigrations(database);
});
afterAll(async () => database.close());
beforeEach(async () => {
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
});

function host(files: Record<string, string>, treeLimit?: number): MemoryProvider {
  const provider = new MemoryProvider();
  provider.createRepository(REF);
  provider.seed(REF, files);
  if (treeLimit !== undefined) provider.setTreeLimit(treeLimit);
  return provider;
}

async function at(provider: MemoryProvider, ...segments: string[]): Promise<Location> {
  // From nothing cached, always: the cache is keyed by commit, so a tree kept from a cut listing would be answered to a whole one.
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
  const read = await readRepository({ provider, cache: new TreeCache(database), format: fjord() }, CONNECTION);
  expect(read.partial, "the listing was whole").toBe(false);
  return locate({ provider, format: fjord() }, read, REF, segments);
}

/**
 * The same for a host whose listing is cut short, from nothing cached: the cache is keyed by commit, and two hosts holding
 * the same files have the same commit, so a tree kept from a whole listing would be answered to a cut one and the test would
 * compare a thing with itself. It checks that the listing really was partial.
 */
async function atCut(provider: MemoryProvider, ...segments: string[]): Promise<Location> {
  await dbRun(database, sql`DELETE FROM ${cacheTable()}`);
  forgetBlobTexts();
  const read = await readRepository({ provider, cache: new TreeCache(database), format: fjord() }, CONNECTION);
  expect(read.partial, "the listing was cut short").toBe(true);
  return locate({ provider, format: fjord() }, read, REF, segments);
}

const shape = (location: Location) =>
  location.kind === "folder"
    ? { kind: "folder", folders: location.folders.map((folder) => folder.name), files: location.files.map((file) => [file.relative, file.kind]) }
    : location.kind === "file"
      ? { kind: "file", file: [location.file.relative, location.file.kind] }
      : { kind: location.kind };

describe.skipIf(!available)(`browsing inside a vault (${leg})`, () => {
  it("lists a vault's top: its folders first (with how many files are in each), then its files, by name without regard to case", async () => {
    const location = await at(host(LAYOUT), "V");
    expect(location).toMatchObject({ kind: "folder", path: "" });
    if (location.kind !== "folder") return;
    expect(location.folders).toEqual([{ name: "Q4", files: 3 }]);
    expect(location.files.map((file) => [file.relative, file.kind])).toEqual([
      ["a.md", "note"],
      ["b.png", "other"],
      ["Z.md", "note"],
    ]);
  });

  it("goes down a folder at a time", async () => {
    const provider = host(LAYOUT);
    expect(shape(await at(provider, "V", "Q4"))).toEqual({ kind: "folder", folders: ["deep"], files: [["Q4/report.fj.md", "document"]] });
    expect(shape(await at(provider, "V", "Q4", "deep"))).toEqual({ kind: "folder", folders: ["more"], files: [["Q4/deep/x.csv", "other"]] });
    expect(shape(await at(provider, "V", "Q4", "deep", "more"))).toEqual({ kind: "folder", folders: [], files: [["Q4/deep/more/y.md", "note"]] });
  });

  it("tells a document from a note and from any other file, by name", async () => {
    const provider = host(LAYOUT);
    expect(shape(await at(provider, "V", "Q4", "report.fj.md"))).toEqual({ kind: "file", file: ["Q4/report.fj.md", "document"] });
    expect(shape(await at(provider, "V", "a.md"))).toEqual({ kind: "file", file: ["a.md", "note"] });
    expect(shape(await at(provider, "V", "b.png"))).toEqual({ kind: "file", file: ["b.png", "other"] });
  });

  it("leads nowhere for a vault, folder or file that is not there", async () => {
    const provider = host(LAYOUT);
    for (const path of [["Nope"], ["V", "nope"], ["V", "Q4", "nope.md"], ["V", "a.md", "inside"], ["V", "Q4", "deep", "nope"], []]) {
      expect((await at(provider, ...path)).kind, path.join("/")).toBe("missing");
    }
  });

  it("does not list a vault's machinery, which is not its content", async () => {
    const found = shape(await at(host(LAYOUT), "S"));
    expect(JSON.stringify(found)).not.toContain("fjord.vault.json");
    expect(JSON.stringify(found)).not.toContain("recipients.txt");
  });

  it("lists an encrypted vault's files as the payloads they are, under their real names", async () => {
    const provider = host(LAYOUT);
    const top = await at(provider, "S");
    expect(top.kind).toBe("folder");
    if (top.kind !== "folder") return;
    expect(top.files.map((file) => [file.relative, file.logical, file.kind])).toEqual([["note.md.age", "note.md", "payload"]]);
    expect(top.folders).toEqual([{ name: "Inner", files: 1 }]);
  });

  it("shows a vault whose names are identifiers as identifiers, which is what it is for (spec §7.2)", async () => {
    const top = await at(host(LAYOUT), "I");
    if (top.kind !== "folder") throw new Error(top.kind);
    expect(top.files.map((file) => [file.logical, file.kind])).toEqual([["01jagc4k7pt8y3wqnmzv5xrb8j", "payload"]]);
  });

  it("says a vault whose manifest cannot be read is unreadable, and lists nothing of it", async () => {
    const location = await at(host({ "Bad/fjord.vault.json": "not json", "Bad/a.md": "a" }), "Bad");
    expect(location.kind).toBe("unreadable");
  });

  it("is an empty folder only at a vault's top: an empty vault is still there", async () => {
    const location = await at(host({ "E/fjord.vault.json": PLAIN }), "E");
    expect(shape(location)).toEqual({ kind: "folder", folders: [], files: [] });
  });

  describe("a path that is not a path", () => {
    it.each([["a segment of .."], ["an empty segment"], ["a backslash"], ["a slash inside a segment"], ["a dot"]])("refuses %s, and never asks the host", async (name) => {
      const segments = { "a segment of ..": ["V", ".."], "an empty segment": ["V", "", "a.md"], "a backslash": ["V", "a\\b"], "a slash inside a segment": ["V", "Q4/deep"], "a dot": ["V", "."] }[name]!;
      const provider = host(LAYOUT, 1);
      const listDirectory = vi.spyOn(provider, "listDirectory");
      const read = await readRepository({ provider, cache: new TreeCache(database), format: fjord() }, CONNECTION);
      listDirectory.mockClear();
      expect((await locate({ provider, format: fjord() }, read, REF, segments)).kind).toBe("missing");
      expect(listDirectory).not.toHaveBeenCalled();
    });

    it("is judged by `safeSegments` alone", () => {
      expect(safeSegments(["V", "a.md"])).toEqual(["V", "a.md"]);
      expect(safeSegments(["V", ".."])).toBeUndefined();
      expect(safeSegments(["V", "a\0b"])).toBeUndefined();
    });
  });

  describe("a repository too large for the host to list", () => {
    it("reads each folder and file the same as when the listing is whole", async () => {
      const whole = host(LAYOUT);
      const cut = host(LAYOUT, 1);
      const paths = [["V"], ["V", "Q4"], ["V", "Q4", "deep"], ["V", "Q4", "deep", "more"], ["V", "a.md"], ["V", "Q4", "report.fj.md"], ["V", "b.png"], ["S"], ["S", "Inner"], ["S", "note.md.age"], ["I"], ["V", "nope"], ["Nope"]];
      for (const path of paths) {
        const a = shape(await at(whole, ...path));
        const b = shape(await atCut(cut, ...path));
        expect(b, path.join("/")).toEqual(a);
      }
    });

    it("asks the host for one directory to show a folder, and for its parent too to find a file", async () => {
      const provider = host(LAYOUT, 1);
      const read = await readRepository({ provider, cache: new TreeCache(database), format: fjord() }, CONNECTION);
      const listDirectory = vi.spyOn(provider, "listDirectory");
      await locate({ provider, format: fjord() }, read, REF, ["V", "Q4"]);
      expect(listDirectory.mock.calls.map((call) => call[2])).toEqual(["V/Q4"]);

      listDirectory.mockClear();
      await locate({ provider, format: fjord() }, read, REF, ["V", "Q4", "report.fj.md"]);
      expect(listDirectory.mock.calls.map((call) => call[2])).toEqual(["V/Q4/report.fj.md", "V/Q4"]);
    });

    it("does not say how many files a folder holds, which it does not know", async () => {
      const top = await atCut(host(LAYOUT, 1), "V");
      if (top.kind !== "folder") throw new Error(top.kind);
      expect(top.folders).toEqual([{ name: "Q4", files: null }]);
    });
  });

  it("reads the same conformance fixtures' vaults the same on either listing", async () => {
    const fixtures = join(process.cwd(), "..", "..", "tests", "fixtures", "documents");
    const files: Record<string, string> = {};
    for (const path of ["fjord.json", "Public/fjord.vault.json", "Public/plan.fj.md", "Public/idea.md"]) files[path] = readFileSync(join(fixtures, path), "utf8");
    const whole = shape(await at(host(files), "Public"));
    const cut = shape(await atCut(host(files, 1), "Public"));
    expect(whole).toEqual({ kind: "folder", folders: [], files: [["idea.md", "note"], ["plan.fj.md", "document"]] });
    expect(cut).toEqual(whole);
  });
});
