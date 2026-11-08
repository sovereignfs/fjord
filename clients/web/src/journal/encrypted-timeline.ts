import type { JournalEntrySummary } from '../format/types';
import type { TimelineEntry } from './timeline';

/**
 * An **encrypted** journal's entries, read for its timeline in the browser (ROADMAP 3b.2, RFC 0001 "Security and privacy"): each entry's
 * ciphertext is fetched by its path, decrypted here with this browser's key, and summarised by the format module. Nothing of what is
 * decrypted is sent anywhere: the only requests are for the ciphertext, by the names the repository already shows (identifiers, spec §7.2),
 * and the timeline is kept in memory and not stored. That is the rule this is written to, and `encrypted-timeline.test.ts` reads every
 * request it makes to hold it to it.
 */
export interface EncryptedTimelineDeps {
  /** The ciphertext of one file of the vault, by its repository path. */
  fetchCiphertext: (path: string) => Promise<Uint8Array>;
  /** Decrypt it (and open its container): the file's real name and its text, or why not. */
  open: (ciphertext: Uint8Array) => { name: string; text: string } | undefined;
  summarise: (text: string, name: string) => JournalEntrySummary;
}

const AT_ONCE = 4;

export async function readEncryptedEntries(
  deps: EncryptedTimelineDeps,
  files: { path: string }[],
  onProgress?: (done: number) => void,
): Promise<{ entries: TimelineEntry[]; unreadable: number }> {
  const entries: TimelineEntry[] = [];
  let unreadable = 0;
  let done = 0;
  let next = 0;
  const work = async () => {
    while (next < files.length) {
      const file = files[next++] as { path: string };
      try {
        const opened = deps.open(await deps.fetchCiphertext(file.path));
        if (opened && /\.md$/i.test(opened.name)) {
          // Its day is the folder it is filed in, which is public; the name inside the container is the minute. Together they are the path a plaintext journal files it by.
          const folder = file.path.split('/').slice(-2, -1)[0];
          entries.push({
            ...deps.summarise(
              opened.text,
              folder === undefined ? opened.name : `${folder}/${opened.name}`,
            ),
            path: file.path,
          });
        } else if (!opened) unreadable += 1;
      } catch {
        unreadable += 1;
      }
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, files.length) }, work));
  return { entries, unreadable };
}

/** How the page asks for an entry's ciphertext: by its path alone, with a GET and no body, from this site. */
export function ciphertextFetcher(
  connectionId: number,
  fetcher: typeof fetch = fetch,
): (path: string) => Promise<Uint8Array> {
  return async (path) => {
    const response = await fetcher(
      `/api/connections/${connectionId}/ciphertext?path=${encodeURIComponent(path)}`,
      { credentials: 'same-origin' },
    );
    if (!response.ok) throw new Error('unreadable');
    return new Uint8Array(await response.arrayBuffer());
  };
}
