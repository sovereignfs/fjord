import { docIdOf } from '../browse/ids';
import { readTextBlob } from '../browse/note';
import type { Fjord } from '../format/wasm';
import { isProviderError } from '../providers/errors';
import type { Identity, Provider, RepositoryRef } from '../providers/types';
import { formatIdentity } from '../working/version';
import { identifyMessage, render } from './messages';

/**
 * Giving a Doc an identifier (DESIGN.md §9, ROADMAP 3e.3, RFC 0002; spec §8.2): the one commit that adds an `id` to a Markdown file that has none. Nothing
 * else about the file changes: its other keys stay as they were, in their order, and so does everything after the header. It is made only when something
 * needs a lasting identity (sharing, publishing, commenting), after the person agreed, and never because a file was opened or edited.
 *
 *  - **On the version the person looked at.** The request names the file's blob; if the repository's is another one, nothing is written (`changed`).
 *  - **The header is `fjord-core`'s** (`promoteDocument`): a file with no header is given `id`, `title` and `created`; a header that has none of its own is
 *    given what is missing and keeps what it has. A header that cannot be read, or a text whose line endings or byte-order mark a header of ours would
 *    disturb, is left alone (`cannot_identify`).
 *  - **Already identified** is not an error: the `id` it has is the answer, and nothing is committed.
 *  - Never forced, retried once when the head moved, with the author the caller's.
 */
export interface IdentifyDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<
    Fjord,
    'parseDocument' | 'promoteDocument' | 'impliedTitle' | 'newUlid' | 'rfc3339FromUnix'
  >;
  /** For tests: milliseconds since the epoch. */
  now?: () => number;
  /** For tests: at least sixteen random bytes. */
  random?: () => Uint8Array;
}

export type IdentifyResult =
  | { ok: true; docId: string; commit: string | null }
  | {
      ok: false;
      reason:
        | 'gone'
        | 'changed'
        | 'not_markdown'
        | 'too_large'
        | 'not_text'
        | 'cannot_identify'
        | 'head_moved'
        | 'read_only'
        | 'bad_token'
        | 'unavailable';
    };

const ATTEMPTS = 2;

export async function identifyFile(
  deps: IdentifyDeps,
  input: { path: string; blob: string; author: Identity },
): Promise<IdentifyResult> {
  if (!/\.md$/i.test(input.path)) return { ok: false, reason: 'not_markdown' };
  const slash = input.path.lastIndexOf('/');
  const directory = input.path.slice(0, slash);
  const name = input.path.slice(slash + 1);
  const author = formatIdentity(input.author);

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed)
        throw new Error('the host answered a head request with no etag as unchanged');
      const expectedHead = head.head.commit;

      const entries = await deps.provider
        .listDirectory(deps.ref, expectedHead, directory)
        .catch((error: unknown) => {
          if (isProviderError(error, 'not_found')) return [];
          throw error;
        });
      const entry = entries.find(
        (candidate) => candidate.path === input.path && candidate.kind === 'file',
      );
      if (!entry) return { ok: false, reason: 'gone' };
      if (entry.id !== input.blob) return { ok: false, reason: 'changed' };

      const read = await readTextBlob(deps.provider, deps.ref, entry.id);
      if (!read.ok)
        return { ok: false, reason: read.reason === 'too_large' ? 'too_large' : 'not_text' };
      const existing = docIdOf(deps.format, read.text);
      if (existing !== null) return { ok: true, docId: existing, commit: null };

      // A header of ours would mix its line endings with a file's own, or move a byte-order mark off the first byte: the file is left as it is.
      if (read.text.includes('\r') || read.text.startsWith('﻿'))
        return { ok: false, reason: 'cannot_identify' };
      const now = deps.now?.() ?? Date.now();
      const docId = deps.format.newUlid(
        now,
        deps.random?.() ?? globalThis.crypto.getRandomValues(new Uint8Array(16)),
      );
      const text = deps.format.promoteDocument(
        read.text,
        docId,
        deps.format.rfc3339FromUnix(Math.floor(now / 1000)),
        deps.format.impliedTitle(read.text, name),
      );
      if (text === undefined || docIdOf(deps.format, text) !== docId)
        return { ok: false, reason: 'cannot_identify' };

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: render(identifyMessage({ path: input.path, docId })),
          author,
          changes: [{ path: input.path, content: new TextEncoder().encode(text) }],
        });
        return { ok: true, docId, commit: made.commit };
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
