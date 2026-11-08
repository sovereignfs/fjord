import { createHash } from 'node:crypto';
import type { Fjord } from '../format/wasm';
import { mapLimit } from '../providers/concurrency';
import { isProviderError } from '../providers/errors';
import type { Identity, Provider, RepositoryRef, TreeEntry } from '../providers/types';
import { formatIdentity } from '../working/version';

/**
 * A site's media library (RFC 0004, ROADMAP 3j): the pictures of an `ssg` repository, listed, added and taken away, and which posts show one.
 *
 *  - **Where they live and what they are called are `fjord-core`'s** (`siteImageDir`, `siteImageName`, `siteImageType`): an `images/` folder in
 *    the site's vault, or `assets/images/` for a Jekyll vault Jekyll cannot serve from. A picture's type is its first bytes, never its name.
 *  - **The server never decodes a picture.** It reads the first bytes, the size, and commits.
 *  - **One commit for a batch**, on the connection's branch, as the person; a file whose bytes are already in the folder is not added again.
 */
export interface ImageDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, 'siteImageType' | 'siteImageDir' | 'siteImageName' | 'siteRefersTo'>;
}

/** The largest picture the library takes: well under the 25 MB the format warns at (spec §1.1, `W604`). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_UPLOAD = 20;
/** The most posts read to find which ones show a picture. */
const MAX_POSTS_READ = 300;
const MAX_POST_BYTES = 512 * 1024;
const PICTURE = /\.(png|jpe?g|gif|webp|avif)$/i;
const POST = /\.(md|markdown|mdx)$/i;
const ATTEMPTS = 2;

export interface ImageEntry {
  /** From the repository's root. */
  path: string;
  name: string;
  size: number;
  /** The git blob id: what a deletion is held to, so that a picture changed since it was shown is not deleted. */
  blob: string;
}

export type ImageFailure =
  'unknown_engine' | 'head_moved' | 'read_only' | 'bad_token' | 'unavailable';

const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** What the git host's error says, as a refusal; anything else is not ours to name. */
function refusal(error: unknown): ImageFailure | undefined {
  if (isProviderError(error, 'forbidden')) return 'read_only';
  if (isProviderError(error, 'unauthorized')) return 'bad_token';
  if (
    isProviderError(error, 'not_found') ||
    isProviderError(error, 'unavailable') ||
    isProviderError(error, 'rate_limited')
  )
    return 'unavailable';
  return undefined;
}

/** The id git gives a file with these bytes. A host that names objects another way never matches, and a picture is then added twice, never lost. */
function blobId(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function head(deps: ImageDeps): Promise<string> {
  const result = await deps.provider.getHead(deps.ref, deps.branch);
  if (!result.changed)
    throw new Error('the host answered a head request with no etag as unchanged');
  return result.head.commit;
}

async function folder(deps: ImageDeps, commit: string, dir: string): Promise<TreeEntry[]> {
  return deps.provider.listDirectory(deps.ref, commit, dir).catch((error: unknown) => {
    if (isProviderError(error, 'not_found')) return [];
    throw error;
  });
}

const isPicture = (entry: TreeEntry) => entry.kind === 'file' && PICTURE.test(entry.path);

/** Every picture of the site, by name: those in the images folder, and any other in the vault (shown and never moved). */
export async function listImages(
  deps: ImageDeps,
  input: { vault: string; engine: string },
): Promise<
  | { ok: true; dir: string; commit: string; images: ImageEntry[] }
  | { ok: false; reason: ImageFailure }
> {
  const dir = deps.format.siteImageDir(input.engine, input.vault);
  if (dir === undefined) return { ok: false, reason: 'unknown_engine' };
  try {
    const commit = await head(deps);
    const tree = await deps.provider.getTree(deps.ref, commit);
    const inVault = (path: string) => input.vault !== '' && path.startsWith(`${input.vault}/`);
    const entries = tree.complete
      ? tree.entries.filter(
          (entry) => isPicture(entry) && (inVault(entry.path) || entry.path.startsWith(`${dir}/`)),
        )
      : (await folder(deps, commit, dir)).filter(isPicture);
    const images = entries
      .map((entry) => ({
        path: entry.path,
        name: name(entry.path),
        size: entry.size ?? 0,
        blob: entry.id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, dir, commit, images };
  } catch (error) {
    const reason = refusal(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
}

export interface UploadFile {
  /** The name it had where it came from; the library names it again. */
  name: string;
  bytes: Uint8Array;
}

export type UploadResult =
  | {
      ok: true;
      commit: string | null;
      images: { name: string; path: string; status: 'added' | 'exists' }[];
    }
  | { ok: false; reason: 'nothing' | 'too_many' | 'too_large' | 'not_an_image'; detail?: string }
  | { ok: false; reason: ImageFailure };

/**
 * Add pictures to the library in one commit. Everything is checked before anything is written: a file that is not a picture of a type the
 * library takes (SVG is not one), or is past the cap, refuses the whole batch and says which.
 */
export async function uploadImages(
  deps: ImageDeps,
  input: { vault: string; engine: string; files: UploadFile[]; author: Identity },
): Promise<UploadResult> {
  const dir = deps.format.siteImageDir(input.engine, input.vault);
  if (dir === undefined) return { ok: false, reason: 'unknown_engine' };
  if (input.files.length === 0) return { ok: false, reason: 'nothing' };
  if (input.files.length > MAX_IMAGES_PER_UPLOAD) return { ok: false, reason: 'too_many' };
  const kinds: string[] = [];
  for (const file of input.files) {
    if (file.bytes.length > MAX_IMAGE_BYTES)
      return { ok: false, reason: 'too_large', detail: file.name };
    const kind = deps.format.siteImageType(file.bytes);
    if (kind === undefined) return { ok: false, reason: 'not_an_image', detail: file.name };
    kinds.push(kind);
  }
  const author = formatIdentity(input.author);

  try {
    for (let attempt = 1; ; attempt++) {
      const expectedHead = await head(deps);
      const there = (await folder(deps, expectedHead, dir)).filter(
        (entry) => entry.kind === 'file',
      );
      const names = there.map((entry) => name(entry.path));
      const byBlob = new Map(there.map((entry) => [entry.id, entry.path]));
      const images: { name: string; path: string; status: 'added' | 'exists' }[] = [];
      const changes: { path: string; content: Uint8Array }[] = [];
      input.files.forEach((file, index) => {
        const id = blobId(file.bytes);
        const known = byBlob.get(id);
        if (known !== undefined) {
          images.push({ name: name(known), path: known, status: 'exists' });
          return;
        }
        const chosen = deps.format.siteImageName(file.name, kinds[index] as string, names);
        names.push(chosen);
        const path = `${dir}/${chosen}`;
        byBlob.set(id, path);
        changes.push({ path, content: file.bytes });
        images.push({ name: chosen, path, status: 'added' });
      });
      if (changes.length === 0) return { ok: true, commit: null, images };
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message:
            changes.length === 1
              ? `Add an image: ${name((changes[0] as { path: string }).path)}`
              : `Add ${changes.length} images`,
          author,
          changes,
        });
        return { ok: true, commit: made.commit, images };
      } catch (error) {
        if (isProviderError(error, 'head_moved')) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: 'head_moved' };
        }
        throw error;
      }
    }
  } catch (error) {
    const reason = refusal(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
}

/** Where a picture may be taken away from: the images folder, or the vault. Anything else of the repository is not the library's. */
export function isLibraryPath(
  deps: Pick<ImageDeps, 'format'>,
  input: { vault: string; engine: string; path: string },
): boolean {
  const dir = deps.format.siteImageDir(input.engine, input.vault);
  if (dir === undefined || !PICTURE.test(input.path) || input.path.split('/').includes('..'))
    return false;
  return (
    input.path.startsWith(`${dir}/`) ||
    (input.vault !== '' && input.path.startsWith(`${input.vault}/`))
  );
}

export type DeleteImageResult =
  | { ok: true; commit: string }
  | { ok: false; reason: 'gone' | 'upstream_changed' | 'not_in_library' | ImageFailure };

/**
 * Take one picture away, in one commit, held to the version the person was shown. For a picture outside the vault (a Jekyll `_posts` site's
 * `assets/images/`); one inside the vault is deleted as any file is, which keeps it for *What was deleted*.
 */
export async function deleteImageOutsideVault(
  deps: ImageDeps,
  input: { vault: string; engine: string; path: string; blob: string; author: Identity },
): Promise<DeleteImageResult> {
  if (!isLibraryPath(deps, input)) return { ok: false, reason: 'not_in_library' };
  const author = formatIdentity(input.author);
  try {
    for (let attempt = 1; ; attempt++) {
      const expectedHead = await head(deps);
      const dir = input.path.slice(0, input.path.lastIndexOf('/'));
      const entry = (await folder(deps, expectedHead, dir)).find(
        (candidate) => candidate.path === input.path && candidate.kind === 'file',
      );
      if (!entry) return { ok: false, reason: 'gone' };
      if (entry.id !== input.blob) return { ok: false, reason: 'upstream_changed' };
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: `Delete an image: ${name(input.path)}`,
          author,
          changes: [{ path: input.path, delete: true }],
        });
        return { ok: true, commit: made.commit };
      } catch (error) {
        if (isProviderError(error, 'head_moved')) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: 'head_moved' };
        }
        throw error;
      }
    }
  } catch (error) {
    const reason = refusal(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
}

/** The posts of the vault that show a picture, by their paths; `complete` is false when there were more posts than are read. */
export async function postsShowing(
  deps: ImageDeps,
  input: { vault: string; imagePath: string },
): Promise<{ ok: true; posts: string[]; complete: boolean } | { ok: false; reason: ImageFailure }> {
  try {
    const commit = await head(deps);
    const tree = await deps.provider.getTree(deps.ref, commit);
    const all = tree.entries.filter(
      (entry) =>
        entry.kind === 'file' &&
        POST.test(entry.path) &&
        input.vault !== '' &&
        entry.path.startsWith(`${input.vault}/`),
    );
    const posts = all.slice(0, MAX_POSTS_READ);
    const hits = await mapLimit(posts, 6, async (entry) => {
      const bytes = await deps.provider
        .readBlob(deps.ref, entry.id, { maxBytes: MAX_POST_BYTES })
        .catch((error: unknown) => {
          if (isProviderError(error, 'too_large') || isProviderError(error, 'not_found'))
            return undefined;
          throw error;
        });
      return bytes !== undefined &&
        deps.format.siteRefersTo(entry.path, new TextDecoder().decode(bytes), input.imagePath)
        ? entry.path
        : undefined;
    });
    return {
      ok: true,
      posts: hits.filter((path): path is string => path !== undefined).sort(),
      complete: tree.complete && all.length <= MAX_POSTS_READ,
    };
  } catch (error) {
    const reason = refusal(error);
    if (reason) return { ok: false, reason };
    throw error;
  }
}
