import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Discovery, ListedFile, LocalMinute, MergeResult, RepositoryManifest, SetupExisting, SetupOptions, SetupResult } from "./types";

/**
 * `fjord-core` as WebAssembly, in Node (DESIGN.md §2: the server reads the format, the browser never does in
 * phase 1). The module is built from `crates/fjord-wasm` (`pnpm build:wasm`) and loaded from where it was
 * built, at run time, not bundled: it is generated, large, and loaded once.
 *
 *   FJORD_WASM_DIR   the directory holding `fjord_wasm.js` and `fjord_wasm_bg.wasm` (`pkg/node` of the
 *                    build). Default: the monorepo's own, next to this app.
 *
 * Nothing here knows the format. Each function hands what it is given to the module and parses the JSON it
 * answers with.
 */

/** What the module exports, as far as this app uses it. */
interface Module {
  formatVersion(): number;
  manifestPaths(filesJson: string): string;
  discover(filesJson: string, manifestsJson: string): string;
  describeRepositoryManifest(text: string): string;
  planSetup(optionsJson: string, existingJson: string, nowMs: number, random: Uint8Array): string;
  freeVaultName(preferred: string, existingJson: string): string;
  mergeTexts(base: string, ours: string, theirs: string, oursLabel: string, theirsLabel: string): string;
  quickNoteName(text: string, existingJson: string, year: number, month: number, day: number, hour: number, minute: number): string;
  titleFromText(text: string): string | undefined;
  freeName(stem: string, extension: string, existingJson: string): string;
  newDocument(id: string, title: string, created: string): string;
  parseDocument(text: string): string;
  checkName(component: string): string;
  caseCollisions(namesJson: string): string;
  newUlid(timestampMs: number, random: Uint8Array): string;
  rfc3339FromUnix(seconds: number): string | undefined;
}

/** The module has not been built, or cannot be loaded: a setup problem, never a repository's. */
export class FormatUnavailableError extends Error {
  override name = "FormatUnavailableError";
}

export function wasmDirectory(env: Record<string, string | undefined> = process.env): string {
  const set = (env.FJORD_WASM_DIR ?? "").trim();
  if (set !== "") return set;
  return join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", "crates", "fjord-wasm", "pkg", "node");
}

/** Whether the module is there to load. */
export function wasmAvailable(directory: string = wasmDirectory()): boolean {
  return existsSync(join(/*turbopackIgnore: true*/ directory, "fjord_wasm.js"));
}

const KEY = Symbol.for("fjord.wasm");
type Holder = { [KEY]?: Map<string, Fjord> };

/** The format, loaded once per process (and across a development reload). */
export function fjord(directory: string = wasmDirectory()): Fjord {
  const holder = globalThis as Holder;
  const loaded = (holder[KEY] ??= new Map());
  let instance = loaded.get(directory);
  if (!instance) {
    instance = new Fjord(load(directory));
    loaded.set(directory, instance);
  }
  return instance;
}

function load(directory: string): Module {
  const file = join(/*turbopackIgnore: true*/ directory, "fjord_wasm.js");
  if (!existsSync(file)) {
    throw new FormatUnavailableError(
      `The Fjord format module is not built (looked for ${file}). Run \`pnpm build:wasm\` (it needs Rust and wasm-bindgen: crates/fjord-wasm/README.md), or set FJORD_WASM_DIR.`,
    );
  }
  try {
    // Through `process.getBuiltinModule`, not an `import`: the bundler treats `createRequire(...)(path)` as a
    // `require` it must resolve at build time and refuses a path it cannot see ("too dynamic"). This is a file
    // the build produced elsewhere, loaded by Node itself at run time.
    const { createRequire } = process.getBuiltinModule("node:module");
    return createRequire(import.meta.url)(file) as Module;
  } catch (error) {
    throw new FormatUnavailableError(`The Fjord format module could not be loaded from ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class Fjord {
  constructor(private readonly module: Module) {}

  /** The format version the module implements. */
  get version(): number {
    return this.module.formatVersion();
  }

  /** The repository-relative paths of the vault manifests a caller has to read to call `discover`. */
  manifestPaths(files: ListedFile[]): string[] {
    return JSON.parse(this.module.manifestPaths(JSON.stringify(files))) as string[];
  }

  /**
   * The vaults of a repository and what is in them, from its listing and the text of its vault manifests,
   * keyed by repository-relative path.
   */
  discover(files: ListedFile[], manifests: Record<string, string>): Discovery {
    return JSON.parse(this.module.discover(JSON.stringify(files), JSON.stringify(manifests))) as Discovery;
  }

  /** `fjord.json`, read. */
  describeRepositoryManifest(text: string): RepositoryManifest {
    return JSON.parse(this.module.describeRepositoryManifest(text)) as RepositoryManifest;
  }

  /**
   * What to add to a repository that is not a Fjord repository so that it is one: a `fjord.json`, one plaintext
   * vault, and the `.gitattributes` merge guard only where it is missing. Pure: the time and at least 80 random
   * bytes are given, and the same call gives the same answer. A finding about the repository (it is one already, the
   * name is taken) is `ok: false`; a malformed call throws.
   */
  planSetup(options: SetupOptions, existing: SetupExisting, nowMs: number, random: Uint8Array): SetupResult {
    return JSON.parse(this.module.planSetup(JSON.stringify(options), JSON.stringify(existing), nowMs, random)) as SetupResult;
  }

  /**
   * Merge two edits (`ours`, `theirs`) of one text (`base`) by lines, as the CLI does. Never an error: when the edits overlap
   * the text has both sides between marker lines labelled with these names, and `clean` is false.
   */
  mergeTexts(base: string, ours: string, theirs: string, labels: { ours: string; theirs: string }): MergeResult {
    return JSON.parse(this.module.mergeTexts(base, ours, theirs, labels.ours, labels.theirs)) as MergeResult;
  }

  /**
   * The file name for a new note typed as `text` (`fjord-core`'s, the one every client uses): from its first line, else
   * from the writer's local date and time, and numbered past the names the folder already has, case aside. Ends in `.md`.
   */
  quickNoteName(text: string, existing: string[], when: LocalMinute): string {
    return this.module.quickNoteName(text, JSON.stringify(existing), when.year, when.month, when.day, when.hour, when.minute);
  }

  /** What a text's first line asks to be called, without an extension; null if there is nothing in it to name a file by. */
  titleFromText(text: string): string | null {
    return this.module.titleFromText(text) ?? null;
  }

  /** `stem` plus `extension`, or `stem 2`, `stem 3`, … plus it: the first no entry of `existing` has (case aside, in NFC). */
  freeName(stem: string, extension: string, existing: string[]): string {
    return this.module.freeName(stem, extension, JSON.stringify(existing));
  }

  /** The text of a new document: its header (`id`, `title`, `created`) written by `fjord-core`, and a level-one heading. */
  newDocument(id: string, title: string, created: string): string {
    return this.module.newDocument(id, title, created);
  }

  /** A file's header, read: whether it has one, and the Doc's identifier if it has a valid one. The body is not the module's here. */
  parseDocument(text: string): { status: string; docId?: string | null; title?: string | null; bodyOffset?: number } {
    return JSON.parse(this.module.parseDocument(text)) as { status: string; docId?: string | null; title?: string | null; bodyOffset?: number };
  }

  /** The codes of the spec §5 rules a path component breaks (`E501`…); none for a name that is fine. */
  checkName(component: string): string[] {
    return JSON.parse(this.module.checkName(component)) as string[];
  }

  /** The groups of names that differ only by case (spec §5 rule 6): those a case-insensitive filesystem would merge. */
  caseCollisions(names: string[]): string[][] {
    return JSON.parse(this.module.caseCollisions(JSON.stringify(names))) as string[][];
  }

  /** A new identifier (spec §8.3) from the time and at least ten random bytes the caller gives. */
  newUlid(timestampMs: number, random: Uint8Array): string {
    return this.module.newUlid(timestampMs, random);
  }

  /** Seconds since the epoch as RFC 3339 in UTC. */
  rfc3339FromUnix(seconds: number): string {
    const text = this.module.rfc3339FromUnix(seconds);
    if (text === undefined) throw new Error("that time cannot be written as a date");
    return text;
  }

  /** A vault name that is free at the root: `preferred`, else `preferred 2`, `preferred 3`, … (case aside). */
  freeVaultName(preferred: string, paths: string[]): string {
    return this.module.freeVaultName(preferred, JSON.stringify({ paths, gitattributes: null }));
  }
}
