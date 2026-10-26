import type { ClassifiedFile, ListedFile, VaultListing } from "../format/types";
import type { Fjord } from "../format/wasm";
import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef, TreeEntry } from "../providers/types";
import type { RepositoryRead } from "./repository";

/**
 * Where a path inside a repository leads (DESIGN.md §8): `/repo/<connection>/<vault>/<folders…>/<file>`. The first
 * segment is a vault, which is a directory at the root (spec §2.3); the rest is inside it.
 *
 * Folders are derived from the paths of what they hold (git has no empty directories, and the host lists files), and
 * what a file is comes from its name: `fjord-core`, as WebAssembly, classified it when the repository was read. A
 * repository too large for the host to list is browsed a directory at a time: the directory is listed from the host
 * and its files are classified the same way, so both read alike. No document is read to draw any of it.
 */
export type Location =
  | { kind: "missing" }
  | { kind: "unreadable"; vault: VaultListing }
  | { kind: "folder"; vault: VaultListing; /** Relative to the vault, `""` for its top. */ path: string; folders: FolderEntry[]; files: ClassifiedFile[] }
  | { kind: "file"; vault: VaultListing; file: ClassifiedFile };

export interface FolderEntry {
  name: string;
  /** How many files are somewhere inside it, when the listing says (not for a directory listed on its own). */
  files: number | null;
}

export interface BrowseDeps {
  provider: Provider;
  format: Fjord;
}

/** A path segment from a URL is a name, never a way out of the repository or an empty step. */
export function safeSegments(segments: string[]): string[] | undefined {
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return undefined;
  }
  return segments;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.name < b.name ? -1 : 1);

export async function locate(deps: BrowseDeps, read: RepositoryRead, ref: RepositoryRef, rawSegments: string[]): Promise<Location> {
  const segments = safeSegments(rawSegments);
  if (!segments || segments.length === 0) return { kind: "missing" };
  const vault = read.discovery.vaults.find((candidate) => candidate.directory === segments[0]);
  if (!vault) return { kind: "missing" };
  if (vault.manifestError !== null) return { kind: "unreadable", vault };

  const inside = segments.slice(1).join("/");
  return read.partial ? fromHost(deps, read, ref, vault, segments, inside) : fromListing(vault, vault.files, inside);
}

/** A folder or file of a vault whose files are all known. */
function fromListing(vault: VaultListing, files: ClassifiedFile[], inside: string): Location {
  const exact = inside === "" ? undefined : files.find((file) => file.relative === inside);
  if (exact) return { kind: "file", vault, file: exact };

  const prefix = inside === "" ? "" : `${inside}/`;
  const here: ClassifiedFile[] = [];
  const folders = new Map<string, number>();
  for (const file of files) {
    if (!file.relative.startsWith(prefix)) continue;
    const rest = file.relative.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) here.push(file);
    else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
  }
  // A path with nothing under it is not a folder, unless it is the vault's own top (an empty vault is still there).
  if (inside !== "" && here.length === 0 && folders.size === 0) return { kind: "missing" };
  return {
    kind: "folder",
    vault,
    path: inside,
    folders: [...folders].map(([name, count]) => ({ name, files: count })).sort(byName),
    files: here.sort((a, b) => byName({ name: a.relative }, { name: b.relative })),
  };
}

/** The same, for a repository whose listing the host cut short: ask the host for this one directory. */
async function fromHost(deps: BrowseDeps, read: RepositoryRead, ref: RepositoryRef, vault: VaultListing, segments: string[], inside: string): Promise<Location> {
  const path = segments.join("/");
  let entries: TreeEntry[];
  try {
    entries = await deps.provider.listDirectory(ref, read.commit, path);
  } catch (error) {
    if (!isProviderError(error, "not_found")) throw error;
    // Not a directory: it may be a file, which its parent's listing names.
    const parent = await deps.provider.listDirectory(ref, read.commit, segments.slice(0, -1).join("/")).catch((failure: unknown) => {
      if (isProviderError(failure, "not_found")) return [] as TreeEntry[];
      throw failure;
    });
    const leaf = parent.find((entry) => entry.path === path && (entry.kind === "file" || entry.kind === "symlink"));
    if (!leaf) return { kind: "missing" };
    const [classified] = classify(deps, read, vault, [leaf]);
    return classified ? { kind: "file", vault, file: classified } : { kind: "missing" };
  }

  const folders: FolderEntry[] = entries.filter((entry) => entry.kind === "directory").map((entry) => ({ name: entry.path.slice(entry.path.lastIndexOf("/") + 1), files: null }));
  const files = classify(deps, read, vault, entries.filter((entry) => entry.kind === "file" || entry.kind === "symlink"));
  return { kind: "folder", vault, path: inside, folders: folders.sort(byName), files: files.sort((a, b) => byName({ name: a.relative }, { name: b.relative })) };
}

/**
 * What the files of one directory are, by asking the module with the vault's own manifest and just these files:
 * what a name means depends on the vault (encrypted or not, its suffix) and on nothing else.
 */
function classify(deps: BrowseDeps, read: RepositoryRead, vault: VaultListing, entries: TreeEntry[]): ClassifiedFile[] {
  const manifestPath = `${vault.directory}/fjord.vault.json`;
  const manifestText = read.manifests[manifestPath];
  if (manifestText === undefined) return [];
  const listed: ListedFile[] = [{ path: manifestPath, size: 0 }, ...entries.map((entry) => ({ path: entry.path, size: entry.size ?? 0 }))];
  const found = deps.format.discover(listed, { [manifestPath]: manifestText });
  return found.vaults.find((candidate) => candidate.directory === vault.directory)?.files ?? [];
}
