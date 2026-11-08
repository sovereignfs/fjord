import { isProviderError } from '../providers/errors';
import type { FileVersion, Provider, RepositoryRef } from '../providers/types';

/**
 * A document's history in the app (research 0002, G7): a version is a commit, and the host has them. Reading is all this does: nothing here writes, and putting an old version back is a draft of its
 * text, which the person looks at and saves as any other, so a commit is never undone or forced, and the versions in between stay in the repository.
 */
export const HISTORY_LIMIT = 50;
/** A document is small; what is much larger is not for a page to show. An encrypted file is read here as the bytes it is, and opened in the browser. */
export const MAX_VERSION_BYTES = 5 * 1024 * 1024;

export async function versionsOf(
  provider: Provider,
  ref: RepositoryRef,
  head: string,
  path: string,
): Promise<{ versions: FileVersion[]; more: boolean } | undefined> {
  if (!provider.fileHistory) return undefined;
  const asked = await provider.fileHistory(ref, head, path, HISTORY_LIMIT + 1);
  return { versions: asked.slice(0, HISTORY_LIMIT), more: asked.length > HISTORY_LIMIT };
}

/** A file's bytes as of a commit, or why not. The commit's own tree says which blob that was, so a commit that does not hold the path has nothing to give. */
export async function versionBytes(
  provider: Provider,
  ref: RepositoryRef,
  commit: string,
  path: string,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: 'missing' | 'too_large' }> {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  try {
    const entry = (await provider.listDirectory(ref, commit, parent)).find(
      (candidate) => candidate.path === path && candidate.kind === 'file',
    );
    if (!entry) return { ok: false, reason: 'missing' };
    return {
      ok: true,
      bytes: await provider.readBlob(ref, entry.id, { maxBytes: MAX_VERSION_BYTES }),
    };
  } catch (error) {
    if (isProviderError(error, 'too_large')) return { ok: false, reason: 'too_large' };
    if (isProviderError(error, 'not_found')) return { ok: false, reason: 'missing' };
    throw error;
  }
}
