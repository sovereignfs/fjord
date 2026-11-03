import { getDatabase } from "../db/boot";
import { placeAddress, vaultAddress } from "./addresses";
import { FileHandles } from "./handles";
import { repositoryHref } from "./links";

/**
 * The addresses of the places in one vault, for a page that draws links to them (workstream 0003). A link is made by the server, where the handles are, and is
 * direct, so that opening a folder is one request and not a redirect; a client that makes a place and then goes to it (`NewFile`, a move, a delete) has no handles
 * and uses the old address by path, which the page sends on. A vault whose manifest has no `id` cannot be in an address, and a place with no handle yet (a listing too
 * large to draw them for) is, so both fall back to the old form, which still arrives.
 */
export class AddressBook {
  constructor(
    private readonly connectionId: number,
    private readonly vault: { directory: string; id: string | null },
    private readonly handles: Map<string, string>,
  ) {}

  /** A path of this vault, repository-relative: its top, a folder, or a file by its handle. */
  href(path: string): string {
    if (path === this.vault.directory) return this.vault.id === null ? repositoryHref(this.connectionId, path) : vaultAddress(this.connectionId, this.vault.id);
    const handle = this.handles.get(path);
    if (this.vault.id === null || handle === undefined) return repositoryHref(this.connectionId, ...path.split("/"));
    return placeAddress(this.connectionId, this.vault.id, { handle }, this.parentOf(path));
  }

  /** A Doc whose `id` is known, by it. */
  docHref(path: string, docId: string): string {
    if (this.vault.id === null) return repositoryHref(this.connectionId, ...path.split("/"));
    return placeAddress(this.connectionId, this.vault.id, { doc: docId }, this.parentOf(path));
  }

  /** A static HTML page by its handle. */
  htmlHref(path: string): string {
    const handle = this.handles.get(path);
    if (this.vault.id === null || handle === undefined) return repositoryHref(this.connectionId, ...path.split("/"));
    return placeAddress(this.connectionId, this.vault.id, { html: handle }, this.parentOf(path));
  }

  /** The handle of the folder a path is in, none when it is at the vault's top. */
  private parentOf(path: string): string | undefined {
    const parent = path.slice(0, path.lastIndexOf("/"));
    return parent === this.vault.directory ? undefined : this.handles.get(parent);
  }
}

/** The book for these paths of a vault, with the handle of each and of the folder each is in made if there is none yet. */
export async function addressBookFor(connectionId: number, vault: { directory: string; id: string | null }, paths: string[]): Promise<AddressBook> {
  const wanted = new Set<string>();
  for (const path of paths) {
    if (path === vault.directory) continue;
    wanted.add(path);
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent !== vault.directory && parent !== "") wanted.add(parent);
  }
  const handles = wanted.size === 0 || vault.id === null ? new Map<string, string>() : await new FileHandles(await getDatabase()).forPaths(connectionId, [...wanted]);
  return new AddressBook(connectionId, vault, handles);
}
