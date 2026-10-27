import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { ListedFile } from "./types";
import type { SetupExisting, SetupOptions } from "./types";
import { fjord, wasmAvailable, wasmDirectory } from "./wasm";

/**
 * The format module, from the web's side (ROADMAP 1a.11): given only a list of paths and a few manifests'
 * text, it says what the CLI's filesystem walk said about every conformance fixture
 * (`tests/fixtures/discovery.json`, recorded before discovery was shared). The module's own suite holds it to
 * the same; this is that, through the loader the app uses.
 *
 * It needs the module built (`pnpm build:wasm`). Where it is not, these are skipped with a note, except in CI,
 * where a missing module is a failure.
 */
const fixtures = join(process.cwd(), "..", "..", "tests", "fixtures");
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);
if (!available) console.warn("[fjord] format tests skipped: the module is not built (pnpm build:wasm)");

const golden = JSON.parse(readFileSync(join(fixtures, "discovery.json"), "utf8")) as Record<
  string,
  {
    discover: "error" | { directory: string; label: string | null; encrypted: boolean; suffix: string; contents: { relative: string; logical: string; is_payload: boolean; size: number }[] }[];
    verify: { nested: string[]; vaults: { path: string; docs: number; files: number }[] };
  }
>;

function listing(root: string): ListedFile[] {
  const out: ListedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push({ path: relative(root, path).split("\\").join("/"), size: lstatSync(path).size });
    }
  };
  walk(root);
  return out;
}

describe.skipIf(!available)("the format module", () => {
  it("implements format version 1", () => {
    expect(fjord().version).toBe(1);
  });

  for (const [name, expected] of Object.entries(golden)) {
    it(`${name}: says what the filesystem walk said`, () => {
      const root = join(fixtures, name);
      const files = listing(root);
      const manifests: Record<string, string> = {};
      for (const path of fjord().manifestPaths(files)) manifests[path] = readFileSync(join(root, path), "utf8");
      const found = fjord().discover(files, manifests);

      expect(found.nested).toEqual(expected.verify.nested);
      if (expected.discover === "error") {
        expect(found.vaults.some((vault) => vault.manifestError !== null)).toBe(true);
        return;
      }
      const wanted = expected.discover;
      expect(found.vaults.map((vault) => vault.directory)).toEqual(wanted.map((vault) => vault.directory));
      found.vaults.forEach((vault, index) => {
        const want = wanted[index]!;
        expect([vault.name, vault.encrypted, vault.suffix]).toEqual([want.label, want.encrypted, want.suffix]);
        expect(vault.files.map((file) => [file.relative, file.logical, file.kind === "payload", file.size])).toEqual(
          want.contents.map((content) => [content.relative, content.logical, content.is_payload, content.size]),
        );
      });
    });
  }

  it("tells a document from a note by name, as the spec says (§8.4)", () => {
    const root = join(fixtures, "documents");
    const files = listing(root);
    const manifests: Record<string, string> = {};
    for (const path of fjord().manifestPaths(files)) manifests[path] = readFileSync(join(root, path), "utf8");
    const kinds = fjord()
      .discover(files, manifests)
      .vaults[0]!.files.map((file) => [file.relative, file.kind]);
    expect(kinds).toEqual([
      ["idea.md", "note"],
      ["plan.fj.md", "document"],
    ]);
  });

  it("reads a repository manifest, and says what is wrong with one that cannot be read", () => {
    const read = fjord().describeRepositoryManifest(readFileSync(join(fixtures, "conforming", "fjord.json"), "utf8"));
    expect(read).toMatchObject({ ok: true, version: 1, vaultsState: "entries" });
    expect(fjord().describeRepositoryManifest("not json")).toMatchObject({ ok: false });
  });

  describe("setting up a repository that is not a Fjord repository (P6)", () => {
    // The recorded answers of `fjord-core` (tests/fixtures/setup.json): what the built module says, case by case,
    // and so what the web client's wrapper must hand back unchanged.
    const cases = JSON.parse(readFileSync(join(fixtures, "setup.json"), "utf8")) as {
      name: string;
      options: SetupOptions;
      existing: SetupExisting;
      nowMs: number;
      randomHex: string;
      expected: unknown;
    }[];
    const bytes = (hex: string) => Uint8Array.from((hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

    for (const recorded of cases) {
      it(`${recorded.name}: says what fjord-core says`, () => {
        expect(fjord().planSetup(recorded.options, recorded.existing, recorded.nowMs, bytes(recorded.randomHex))).toEqual(recorded.expected);
      });
    }

    it("numbers a vault name after what is at the root", () => {
      expect(fjord().freeVaultName("Public", ["README.md"])).toBe("Public");
      expect(fjord().freeVaultName("Public", ["public/a.md"])).toBe("Public 2");
    });

    it("throws for a malformed call and does not for a finding", () => {
      const existing = { paths: [], gitattributes: null };
      const options = { repositoryName: "r", vault: "V", generator: "g" };
      expect(fjord().planSetup(options, existing, 1e12, new Uint8Array(80)).ok).toBe(true);
      expect(() => fjord().planSetup(options, existing, 1e12, new Uint8Array(10))).toThrow();
      expect(fjord().planSetup(options, { paths: ["fjord.json"], gitattributes: null }, 1e12, new Uint8Array(80))).toMatchObject({ ok: false, error: { code: "already_fjord" } });
    });
  });

  describe("merging", () => {
    const labels = { ours: "Your changes", theirs: "In the repository" };

    it("merges edits in different places, and keeps both sides of edits in the same place", () => {
      expect(fjord().mergeTexts("one\ntwo\nthree\nfour\nfive\n", "ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n", labels)).toEqual({
        clean: true,
        conflicts: 0,
        text: "ONE\ntwo\nthree\nfour\nFIVE\n",
      });
      expect(fjord().mergeTexts("a\nsame\nz\n", "a\nmine\nz\n", "a\ntheirs\nz\n", labels)).toEqual({
        clean: false,
        conflicts: 1,
        text: "a\n<<<<<<< Your changes\nmine\n=======\ntheirs\n>>>>>>> In the repository\nz\n",
      });
    });

    it("keeps line endings, a byte order mark and what is not ASCII exactly", () => {
      const base = "\ufeff# 日本\r\n\r\nline  \r\nlast";
      const merged = fjord().mergeTexts(base, base.replace("line  ", "LINE  "), base.replace("日本", "日本語"), labels);
      expect(merged).toEqual({ clean: true, conflicts: 0, text: "\ufeff# 日本語\r\n\r\nLINE  \r\nlast" });
    });
  });

  it("is loaded once, whatever asks", () => {
    expect(fjord()).toBe(fjord());
  });
});
