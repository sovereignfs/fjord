import { type HeadCache } from "./head-cache";
import type { Discovery, ListedFile, RepositoryManifest } from "../format/types";
import type { Fjord } from "../format/wasm";
import { mapLimit } from "../providers/concurrency";
import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef, Tree, TreeEntry } from "../providers/types";
import { blobText } from "./blob-text";
import type { TreeCache } from "./tree-cache";

/**
 * A repository as the browser sees it at its head (DESIGN.md §8): which vaults it has, and what is in them.
 *
 * Everything is read the way the design says, and nothing more: the **head** (one request), the **tree** of
 * that commit (one request, and none if it is cached: a commit's tree never changes), and the few small
 * **manifests** it names (cached by blob id for the same reason). Not one file's content is read to draw it:
 * what a file is comes from its name (`fjord-core`, as WebAssembly, given the listing). A very large
 * repository's listing comes back cut short, and then the vaults are found directory by directory instead.
 */
export interface RepositoryRead {
  /** The head this is a view of. */
  commit: string;
  branch: string;
  /** Whether `fjord.json` is at the root. Its absence is not an error: vaults are found from the listing. */
  manifest: RepositoryManifest | null;
  discovery: Discovery;
  /**
   * True when the host cut the listing short, so the vaults are known but not the files in them: each
   * vault's `files` is empty and its contents are listed one directory at a time (`listDirectory`).
   */
  partial: boolean;
  /** Blob ids by repository-relative path, for what the listing named, so a file can be read later. */
  blobs: Map<string, string>;
  /** The text of each vault manifest that was read, by repository-relative path: what classifying a name needs. */
  manifests: Record<string, string>;
}

export interface RepositoryDeps {
  provider: Provider;
  cache: TreeCache;
  format: Fjord;
  /** The heads seen before, so that the host can answer "not moved" for free. Without it every view reads the head whole. */
  heads?: HeadCache;
  /** For tests. */
  now?: () => number;
}

/** A manifest is small; a larger one is not read (a hostile repository should not make the server fetch a gigabyte). */
const MAX_MANIFEST_BYTES = 256 * 1024;
const DIRECTORIES_AT_ONCE = 6;
const ROOT_MANIFEST = "fjord.json";
const VAULT_MANIFEST = "fjord.vault.json";

/**
 * The commit a branch is at now. The host is asked at every view; if this process has seen the branch before it sends the `ETag` it was
 * given, and a `304` (not moved, and free of the host's rate limit) is answered with the commit seen then.
 */
export async function headCommit(provider: Provider, heads: HeadCache | undefined, connection: { id: number; ref: RepositoryRef; branch: string }): Promise<string> {
  const known = heads?.get(connection.id, connection.ref, connection.branch);
  const head = await provider.getHead(connection.ref, connection.branch, known ? { etag: known.etag } : {});
  if (head.changed) {
    if (heads && head.head.etag) heads.put(connection.id, connection.ref, connection.branch, { etag: head.head.etag, commit: head.head.commit });
    return head.head.commit;
  }
  if (!known) throw new Error("the host answered a head request with no etag as unchanged");
  return known.commit;
}

export async function readRepository(deps: RepositoryDeps, connection: { id: number; ref: RepositoryRef; branch: string }): Promise<RepositoryRead> {
  const { provider, cache, format } = deps;
  const commit = await headCommit(provider, deps.heads, connection);

  let tree = await cache.get(connection.id, commit);
  if (!tree) {
    tree = await provider.getTree(connection.ref, commit);
    await cache.put(connection.id, tree, deps.now?.());
  }

  const blobs = new Map<string, string>();
  for (const entry of tree.entries) if (isFile(entry)) blobs.set(entry.path, entry.id);

  const found = tree.complete ? await fromListing(deps, connection.ref, tree, blobs) : await fromDirectories(deps, connection.ref, commit, blobs);
  return { commit, branch: connection.branch, ...found, blobs };
}

const isFile = (entry: TreeEntry) => entry.kind === "file" || entry.kind === "symlink";

async function fromListing(deps: RepositoryDeps, ref: RepositoryRef, tree: Tree, blobs: Map<string, string>) {
  const files: ListedFile[] = tree.entries.filter(isFile).map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
  const manifests = await readManifests(deps, ref, blobs, deps.format.manifestPaths(files));
  const manifest = await readRepositoryManifest(deps, ref, blobs);
  return { manifest, discovery: deps.format.discover(files, manifests), partial: false, manifests };
}

/**
 * The fallback for a listing the host cut short (DESIGN.md §8): the root, then each top-level directory, one
 * request each, looking for the vault manifests. That finds the vaults; what is inside them is for browsing,
 * a directory at a time.
 */
async function fromDirectories(deps: RepositoryDeps, ref: RepositoryRef, commit: string, blobs: Map<string, string>) {
  const root = await deps.provider.listDirectory(ref, commit, "");
  for (const entry of root) if (isFile(entry)) blobs.set(entry.path, entry.id);

  const directories = root.filter((entry) => entry.kind === "directory" && entry.path !== ".git" && entry.path !== ".fjord");
  const inside = await mapLimit(directories, DIRECTORIES_AT_ONCE, (directory) => deps.provider.listDirectory(ref, commit, directory.path));
  const files: ListedFile[] = [];
  for (const entries of inside) {
    for (const entry of entries) {
      if (isFile(entry)) blobs.set(entry.path, entry.id);
      if (isFile(entry) && entry.path.endsWith(`/${VAULT_MANIFEST}`)) files.push({ path: entry.path, size: entry.size ?? 0 });
    }
  }

  const manifests = await readManifests(deps, ref, blobs, deps.format.manifestPaths(files));
  const manifest = await readRepositoryManifest(deps, ref, blobs);
  // Only the manifests were listed, and a manifest is machinery, so no vault has files here: they are for browsing.
  return { manifest, discovery: deps.format.discover(files, manifests), partial: true, manifests };
}

async function readManifests(deps: RepositoryDeps, ref: RepositoryRef, blobs: Map<string, string>, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const read = await mapLimit(paths, DIRECTORIES_AT_ONCE, async (path) => [path, await textOf(deps, ref, blobs.get(path))] as const);
  for (const [path, text] of read) if (text !== undefined) out[path] = text;
  return out;
}

async function readRepositoryManifest(deps: RepositoryDeps, ref: RepositoryRef, blobs: Map<string, string>): Promise<RepositoryManifest | null> {
  const text = await textOf(deps, ref, blobs.get(ROOT_MANIFEST));
  return text === undefined ? null : deps.format.describeRepositoryManifest(text);
}

/** A small file's text by blob id, or undefined if there is none or it is too large to be a manifest. */
async function textOf(deps: RepositoryDeps, ref: RepositoryRef, blob: string | undefined): Promise<string | undefined> {
  if (blob === undefined) return undefined;
  try {
    return await blobText(deps.provider, ref, blob, MAX_MANIFEST_BYTES);
  } catch (error) {
    if (isProviderError(error, "too_large") || isProviderError(error, "not_found")) return undefined;
    throw error;
  }
}
