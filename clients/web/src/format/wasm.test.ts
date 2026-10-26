import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { ListedFile } from "./types";
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

  it("is loaded once, whatever asks", () => {
    expect(fjord()).toBe(fjord());
  });
});
