import type { ClassifiedFile } from "../format/types";
import type { Fjord } from "../format/wasm";
import { mapLimit } from "../providers/concurrency";
import type { Provider, RepositoryRef } from "../providers/types";
import type { DocIndex, IndexedFile } from "./doc-index";
import { readTextBlob } from "./note";
import type { RepositoryRead } from "./repository";

/**
 * Finding a file by its Doc `id` (DESIGN.md §9, ROADMAP 1b.6): `/doc/<id>` and `/note/<id>` ask for a file without saying
 * where it is. The answer comes from the index (`doc-index.ts`), which is only a record of what was read, so it is never
 * believed on its own:
 *
 *  - A row counts only if the repository **now** has that blob at that path. A file edited, moved or deleted elsewhere is
 *    read again, or forgotten; the index cannot send anyone to a file that is not there, or to the wrong text.
 *  - When no row is good, the repository's plaintext Markdown files that were never read, or have changed, are read, a
 *    bounded number at a time, and recorded (files with no `id` too, so they are not read twice). That is the search the
 *    background pass of the worker will do ahead of time (1b.13); until it runs, a first lookup does a share of it.
 *  - A very large repository's cut-short listing names no files, so none is searched; and an encrypted vault is never read.
 *
 * An id is unique within a repository (spec E401) but not across them, and a copy nobody has read is not in the index; a
 * lookup says what it found, all of it, and the page asks the person when that is more than one.
 */
export interface Source {
  connectionId: number;
  ref: RepositoryRef;
  read: RepositoryRead;
  provider: Provider;
}

export interface Found {
  connectionId: number;
  path: string;
  kind: "note" | "document";
}

export interface Resolution {
  matches: Found[];
  /** True when the search stopped at its limit with files still unread, so that "no match" is not yet "there is none". */
  incomplete: boolean;
}

/** How many files one lookup reads at most, and how many at a time. */
export const SEARCH_BUDGET = 300;
const AT_ONCE = 6;

/** A lowercase ULID (spec §8.3): 26 characters of Crockford's alphabet, the first no more than 7 so that it fits 128 bits. */
export function isDocId(value: string): boolean {
  return /^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(value);
}

/** The notes and documents of the plaintext vaults of a read repository, by path, with the blob each has now. */
export function plaintextDocs(read: RepositoryRead): Map<string, { kind: "note" | "document"; blob: string }> {
  const out = new Map<string, { kind: "note" | "document"; blob: string }>();
  for (const vault of read.discovery.vaults) {
    if (vault.manifestError !== null || vault.encrypted !== false) continue;
    for (const file of vault.files) {
      const blob = read.blobs.get(file.path);
      if (blob !== undefined && (file.kind === "note" || file.kind === "document")) out.set(file.path, { kind: file.kind, blob });
    }
  }
  return out;
}

/** The `id` a text's header gives it, or null: none, an invalid one, or a header that cannot be read. */
export function docIdOf(format: Pick<Fjord, "parseDocument">, text: string): string | null {
  const parsed = format.parseDocument(text);
  return parsed.status === "present" && typeof parsed.docId === "string" ? parsed.docId : null;
}

/** Record a file that was just read for the page (reading it is the only way to know its `id`, and the page has it). */
export async function recordRead(index: DocIndex, format: Pick<Fjord, "parseDocument">, connectionId: number, file: ClassifiedFile, blob: string, text: string): Promise<void> {
  if (file.kind !== "note" && file.kind !== "document") return;
  await index.put(connectionId, [{ path: file.path, docId: docIdOf(format, text), kind: file.kind, blob }]);
}

interface Deps {
  index: DocIndex;
  format: Pick<Fjord, "parseDocument">;
}

/** Read these files and record what they say; a file that is not text, or too large, is recorded as having no `id`. */
async function readAndRecord(deps: Deps, source: Source, wanted: [string, { kind: "note" | "document"; blob: string }][]): Promise<void> {
  const read = await mapLimit(wanted, AT_ONCE, async ([path, current]): Promise<IndexedFile> => {
    const text = await readTextBlob(source.provider, source.ref, current.blob);
    return { path, kind: current.kind, blob: current.blob, docId: text.ok ? docIdOf(deps.format, text.text) : null };
  });
  await deps.index.put(source.connectionId, read);
}

export async function resolveDocId(deps: Deps, sources: Source[], docId: string, budget: number = SEARCH_BUDGET): Promise<Resolution> {
  const current = new Map(sources.map((source) => [source.connectionId, plaintextDocs(source.read)]));
  const bySource = new Map(sources.map((source) => [source.connectionId, source]));
  const ids = sources.map((source) => source.connectionId);

  const good = async (): Promise<Found[]> => {
    const rows = await deps.index.find(ids, docId);
    return rows.flatMap(({ connectionId, file }) => {
      const now = current.get(connectionId)?.get(file.path);
      return now !== undefined && now.blob === file.blob ? [{ connectionId, path: file.path, kind: file.kind }] : [];
    });
  };

  // What the index says, where it is still true. A row whose file has changed is read again: it may still have this id. A
  // file that was moved or deleted is not at its row's path, so that row is no match, and a move is found by the search below.
  const rows = await deps.index.find(ids, docId);
  for (const [connectionId, group] of Map.groupBy(rows, (row) => row.connectionId)) {
    const now = current.get(connectionId);
    const source = bySource.get(connectionId);
    if (!now || !source) continue;
    const changed = group
      .filter(({ file }) => now.has(file.path) && now.get(file.path)?.blob !== file.blob)
      .map(({ file }) => [file.path, now.get(file.path)!] as [string, { kind: "note" | "document"; blob: string }]);
    if (changed.length > 0) await readAndRecord(deps, source, changed);
  }
  let matches = await good();
  if (matches.length > 0) return { matches, incomplete: false };

  // Nothing good: read what has not been read, within the budget.
  let left = budget;
  let incomplete = false;
  for (const source of sources) {
    const now = current.get(source.connectionId) ?? new Map();
    const indexed = await deps.index.all(source.connectionId);
    // A listing the host cut short names no files, so the index's rows are not judged by it.
    if (!source.read.partial) {
      const gone = [...indexed.keys()].filter((path) => !now.has(path));
      if (gone.length > 0) await deps.index.remove(source.connectionId, gone);
    }
    const unread = [...now].filter(([path, file]) => indexed.get(path)?.blob !== file.blob);
    const some = unread.slice(0, left);
    if (some.length > 0) await readAndRecord(deps, source, some);
    left -= some.length;
    if (some.length < unread.length) incomplete = true;
  }
  matches = await good();
  return { matches, incomplete: matches.length === 0 && incomplete };
}
