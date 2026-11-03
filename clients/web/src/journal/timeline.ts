import type { Fjord } from "../format/wasm";
import type { JournalEntrySummary, VaultListing } from "../format/types";
import { mapLimit } from "../providers/concurrency";
import type { Provider, RepositoryRef } from "../providers/types";
import { blobText } from "../browse/blob-text";
import { isProviderError } from "../providers/errors";
import type { JournalIndex } from "./index-store";

/**
 * A plaintext journal's timeline (ROADMAP 3b.2, RFC 0001): every entry, newest first, grouped by the writer's day, and paged. Where each
 * falls is `fjord-core`'s (`journalEntry`): its `date`, else its path, else its `created`, so an entry moved anywhere in the vault keeps its
 * place. It is derived, never committed (spec §2.2): what was read of each entry is kept by its blob (`JournalIndex`), and a view reads from
 * the host only the entries it has not read before. Not for an encrypted journal, whose timeline is built in the browser (`screens/EncryptedTimeline.tsx`).
 */
export interface TimelineEntry extends JournalEntrySummary {
  /** Repository-relative. */
  path: string;
}

export interface TimelineDay {
  /** `YYYY-MM-DD`, or null for the entries nothing dates. */
  day: string | null;
  entries: TimelineEntry[];
}

export interface Timeline {
  days: TimelineDay[];
  /** Entries in all, and on this page. */
  total: number;
  page: number;
  pages: number;
  /** Every tag of the journal, as written the first time it was seen, with how many entries carry it (3b.3). */
  tags: { tag: string; count: number }[];
}

export interface TimelineDeps {
  provider: Provider;
  ref: RepositoryRef;
  format: Pick<Fjord, "journalEntry" | "foldTag" | "tagIsUnder">;
  index: JournalIndex;
}

/** How many entries a page shows. */
export const PAGE_SIZE = 50;
const READS_AT_ONCE = 6;
/** An entry is a note; one larger than this is shown by its name, not read. */
const MAX_ENTRY_BYTES = 512 * 1024;

/** What may narrow the timeline (3b.3): tags it must have (each, or one under it), and a range of days. */
export interface TimelineFilter {
  tags?: string[];
  from?: string;
  to?: string;
}

/** Every summary of the vault's Docs at the head, read only where the index does not have it. */
export async function summaries(deps: TimelineDeps, connectionId: number, vault: VaultListing, blobs: Map<string, string>): Promise<TimelineEntry[]> {
  const files = vault.files.filter((file) => file.kind === "doc").flatMap((file) => {
    const blob = blobs.get(file.path);
    return blob === undefined ? [] : [{ path: file.path, relative: file.relative, blob, size: file.size }];
  });
  const keys = files.map(({ path, blob }) => ({ path, blob }));
  const known = await deps.index.get(connectionId, keys);
  const missing = files.filter((file) => !known.has(`${file.blob} ${file.path}`));
  const read = await mapLimit(missing, READS_AT_ONCE, async (file) => {
    // Too large is a fact about the blob, kept as an entry with no header; any other failure is the host's, and is not kept.
    const text = file.size > MAX_ENTRY_BYTES ? "" : await blobText(deps.provider, deps.ref, file.blob, MAX_ENTRY_BYTES).catch((error: unknown) => {
      if (isProviderError(error, "too_large")) return "";
      throw error;
    });
    return { path: file.path, blob: file.blob, summary: deps.format.journalEntry(text, file.relative) };
  });
  if (read.length > 0) await deps.index.put(connectionId, read);
  for (const entry of read) known.set(`${entry.blob} ${entry.path}`, entry.summary);
  if (missing.length > 0) await deps.index.retain(connectionId, keys);
  return files.flatMap((file) => {
    const summary = known.get(`${file.blob} ${file.path}`);
    return summary ? [{ ...summary, path: file.path }] : [];
  });
}

/** The page asked for of the timeline of these entries, newest first, by day. */
export function arrange(format: Pick<Fjord, "foldTag" | "tagIsUnder">, entries: TimelineEntry[], options: { page?: number; filter?: TimelineFilter } = {}): Timeline {
  const tags = tagCounts(format, entries);
  const filter = options.filter ?? {};
  const kept = entries.filter((entry) => {
    const day = entry.when?.day;
    if (filter.from && (day === undefined || day < filter.from)) return false;
    if (filter.to && (day === undefined || day > filter.to)) return false;
    return (filter.tags ?? []).every((wanted) => entry.tags.some((tag) => format.tagIsUnder(tag, wanted)));
  });
  // Newest first; an undated entry last; the same moment by path, so the order is the same at every view.
  kept.sort((a, b) => {
    const ka = a.when?.sortKey;
    const kb = b.when?.sortKey;
    if (ka !== kb) return ka === undefined ? 1 : kb === undefined ? -1 : ka < kb ? 1 : -1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  const pages = Math.max(1, Math.ceil(kept.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, options.page ?? 1), pages);
  const shown = kept.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const days: TimelineDay[] = [];
  for (const entry of shown) {
    const day = entry.when?.day ?? null;
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return { days, total: kept.length, page, pages, tags };
}

/**
 * Every tag, counted once per entry and compared as spec §8.1 says (`foldTag`): `Work` and `work` are one tag, shown as it was first
 * written. Sorted by how many entries carry it, then by name.
 */
export function tagCounts(format: Pick<Fjord, "foldTag">, entries: { tags: string[] }[]): { tag: string; count: number }[] {
  const counted = new Map<string, { tag: string; count: number }>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const tag of entry.tags) {
      const folded = format.foldTag(tag);
      if (seen.has(folded)) continue;
      seen.add(folded);
      const known = counted.get(folded);
      if (known) known.count += 1;
      else counted.set(folded, { tag, count: 1 });
    }
  }
  return [...counted.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
