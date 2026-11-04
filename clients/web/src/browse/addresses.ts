import { isHandle } from "./handles";
import { isDocId } from "./ids";

/**
 * The addresses of a repository's places (workstream 0003, DESIGN.md §9), made of ids and never of a path:
 *
 *     /repo/<repo>                                         the repository
 *     /repo/<repo>/v/<vault>                               a vault (the manifest's `id`)
 *     /repo/<repo>/v/<vault>/<folder>                      a folder (its handle)
 *     /repo/<repo>/v/<vault>/<folder>/<file>               a file (its handle)
 *     /repo/<repo>/v/<vault>/<folder>/d/<doc>              a Doc (its `id`)
 *     /repo/<repo>/v/<vault>/<folder>/html/<file>          a static HTML page (its handle), run in a sandbox
 *     /repo/<repo>/n/<note>                                a journal's note (its `id`, or its handle when it is encrypted and has none the server can read)
 *     /repo/<repo>/post/<post>                             a site's post (its `id`, or its handle when the file has none)
 *     /repo/<repo>/deleted                                 what was deleted from the repository, within the restore window
 *
 * and the same without `<folder>` for what is at a vault's top. **Only the last id says what is shown**: the vault and the folder in front of it describe
 * where it was when the address was made, so a file that has since been moved is still found by its own id, and the page then sends the person to its address as
 * it is now. Only the folder a thing is in appears, never the chain above it. A folder or a file that has no id of its own has a handle, which is derived
 * data kept by the app (`handles.ts`); a Doc has the `id` in its header. `v`, `d` can be neither: a handle is 16 characters, an id 26.
 *
 * What was `/repo/<repo>/<path…>` is `legacy`: the page sends it on. A vault whose directory is named `v` is told apart by what follows it: a vault's id.
 * This module is pure: it knows the shapes, and nothing about what is in a repository.
 */
export type Address =
  | { kind: "repository" }
  | { kind: "vault"; vault: string }
  | { kind: "place"; vault: string; /** The handle of the folder it is in, when it is in one. */ parent?: string | undefined; target: { handle: string } | { doc: string } | { html: string } }
  | { kind: "note"; /** `n` for a journal's note, `post` for a site's post. */ as: "n" | "post"; target: { doc: string } | { handle: string } }
  | { kind: "deleted" }
  | { kind: "legacy"; segments: string[] }
  | { kind: "invalid" };

/** The segments of a `/repo/<repo>/…` address after the repository, decoded. */
export function parseAddress(segments: string[]): Address {
  if (segments.length === 0) return { kind: "repository" };
  const [first, second, ...tail] = segments;
  // What was deleted: `deleted` alone. A vault or a folder of that name is still reached by its own address of ids.
  if (first === "deleted" && segments.length === 1) return { kind: "deleted" };
  // A journal's note: `n` and one id. A vault named `n` with some other name after it is the old address by path.
  if ((first === "n" || first === "post") && segments.length === 2 && second !== undefined) {
    if (isDocId(second)) return { kind: "note", as: first, target: { doc: second } };
    if (isHandle(second)) return { kind: "note", as: first, target: { handle: second } };
  }
  if (first !== "v" || second === undefined || !isDocId(second)) return { kind: "legacy", segments };
  const vault = second;
  if (tail.length === 0) return { kind: "vault", vault };
  const last = tail[tail.length - 1] as string;
  const marker = tail.length >= 2 ? tail[tail.length - 2] : undefined;
  if (marker === "html") {
    if (!isHandle(last) || tail.length > 3) return { kind: "invalid" };
    return placed(vault, tail.length === 3 ? tail[0] : undefined, { html: last });
  }
  if (marker === "d") {
    if (!isDocId(last) || tail.length > 3) return { kind: "invalid" };
    return placed(vault, tail.length === 3 ? tail[0] : undefined, { doc: last });
  }
  if (tail.length > 2 || !isHandle(last)) return { kind: "invalid" };
  return placed(vault, tail.length === 2 ? tail[0] : undefined, { handle: last });
}

function placed(vault: string, parent: string | undefined, target: { handle: string } | { doc: string } | { html: string }): Address {
  if (parent !== undefined && !isHandle(parent)) return { kind: "invalid" };
  return { kind: "place", vault, parent, target };
}

export const repositoryAddress = (connection: string): string => `/repo/${connection}`;

export { deletedAddress } from "./links";

export const vaultAddress = (connection: string, vault: string): string => `${repositoryAddress(connection)}/v/${vault}`;

/** A folder or file by its handle, a Doc by its `id`, or an HTML page by its handle, with the handle of the folder it is in. */
export function placeAddress(connection: string, vault: string, target: { handle: string } | { doc: string } | { html: string }, parent?: string): string {
  const front = `${vaultAddress(connection, vault)}${parent === undefined ? "" : `/${parent}`}`;
  return "doc" in target ? `${front}/d/${target.doc}` : "html" in target ? `${front}/html/${target.html}` : `${front}/${target.handle}`;
}

/** A journal's note (`n`) or a site's post (`post`), by its `id` or, with none, its handle. */
export const noteAddress = (connection: string, target: { doc: string } | { handle: string }, as: "n" | "post" = "n"): string => `${repositoryAddress(connection)}/${as}/${"doc" in target ? target.doc : target.handle}`;
