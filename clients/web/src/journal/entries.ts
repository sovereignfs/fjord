import type { Fjord } from '../format/wasm';
import type { VaultListing } from '../format/types';
import { isProviderError } from '../providers/errors';
import type { Identity, Provider, RepositoryRef } from '../providers/types';
import { formatIdentity } from '../working/version';

/**
 * A new journal entry (ROADMAP 3b.1, spec §3.1, §8.1): a note dated now in the writer's own time, one commit through the owner's token.
 *
 *  - **The date is the writer's**, sent as the moment and the writer's offset from UTC, and written by the format module, offset and
 *    all: an entry made just after midnight belongs to that day, whatever the day is in UTC.
 *  - **Where it goes is `fjord-core`'s** (`journalEntryPath`): `YYYY-MM-DD/hh-mm.md`, a folder for the day and a file named by the minute, with
 *    nothing of the title. A second entry in the same minute takes a number, as a copy does. A folder that is not there yet is simply made by
 *    the commit: git has no folders.
 *  - **Plaintext only.** An encrypted journal's entry is written and encrypted in the browser, in the same day folder (whose name is public, by
 *    the owner's choice: workstream 0003), and is made by the encrypted files' route like any file of an encrypted vault
 *    (`files/create-encrypted.ts`): its time and title are never the server's to see.
 */
export interface EntryDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<
    Fjord,
    'entryDateFromUnix' | 'journalEntryPath' | 'newEntry' | 'newUlid' | 'rfc3339FromUnix'
  >;
  now?: () => number;
  random?: () => Uint8Array;
}

export type EntryResult =
  | { ok: true; path: string; commit: string; date: string }
  | { ok: false; reason: 'bad_date' | 'head_moved' | 'read_only' | 'bad_token' | 'unavailable' };

/** The one vault of a journal, if it is one an entry can be written to here: plaintext, with plain names. */
export function journalVault(
  vaults: VaultListing[],
): VaultListing | 'none' | 'encrypted' | 'unsupported' {
  if (vaults.length !== 1) return 'none';
  const vault = vaults[0] as VaultListing;
  if (vault.manifestError !== null) return 'unsupported';
  if (vault.encrypted === true) return 'encrypted';
  return vault.encrypted === false && vault.fileNaming === 'plain' ? vault : 'unsupported';
}

const ATTEMPTS = 2;

export async function createEntry(
  deps: EntryDeps,
  input: { vault: string; at: number; offsetMinutes: number; title: string; author: Identity },
): Promise<EntryResult> {
  const date = deps.format.entryDateFromUnix(Math.floor(input.at / 1000), input.offsetMinutes);
  if (date === undefined) return { ok: false, reason: 'bad_date' };
  const title = input.title.trim();
  const leaf = deps.format.journalEntryPath(date);
  if (leaf === undefined) return { ok: false, reason: 'bad_date' };
  const now = deps.now?.() ?? Date.now();
  const id = deps.format.newUlid(
    now,
    deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)),
  );
  const created = deps.format.rfc3339FromUnix(Math.floor(now / 1000));
  if (created === undefined) return { ok: false, reason: 'bad_date' };
  const text = deps.format.newEntry(id, title === '' ? undefined : title, created, date);
  const author = formatIdentity(input.author);

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed)
        throw new Error('the host answered a head request with no etag as unchanged');
      const expectedHead = head.head.commit;

      const wanted = `${input.vault}/${leaf}`;
      const folder = wanted.slice(0, wanted.lastIndexOf('/'));
      const there = await deps.provider
        .listDirectory(deps.ref, expectedHead, folder)
        .catch((error: unknown) => {
          if (isProviderError(error, 'not_found')) return [];
          throw error;
        });
      const taken = new Set(there.map((entry) => entry.path.toLowerCase()));
      let path = wanted;
      for (let number = 2; taken.has(path.toLowerCase()); number++)
        path = `${wanted.slice(0, -'.md'.length)}-${number}.md`;

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          // The journal is plaintext: its entries' paths and titles are in the repository anyway.
          message:
            title === ''
              ? `Add a journal entry, ${date.slice(0, 10)}`
              : `Add a journal entry: ${title}`,
          author,
          changes: [{ path, content: new TextEncoder().encode(text) }],
        });
        return { ok: true, path, commit: made.commit, date };
      } catch (error) {
        if (isProviderError(error, 'head_moved')) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: 'head_moved' };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, 'forbidden')) return { ok: false, reason: 'read_only' };
    if (isProviderError(error, 'unauthorized')) return { ok: false, reason: 'bad_token' };
    if (
      isProviderError(error, 'not_found') ||
      isProviderError(error, 'unavailable') ||
      isProviderError(error, 'rate_limited')
    )
      return { ok: false, reason: 'unavailable' };
    throw error;
  }
}
