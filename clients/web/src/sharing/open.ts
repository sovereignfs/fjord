import { type Role, decide } from "../access/policy";
import { bodyStartOf } from "../browse/document";
import type { DocIndex } from "../browse/doc-index";
import { resolveDocId, type Source } from "../browse/ids";
import { readTextBlob } from "../browse/note";
import type { Fjord } from "../format/wasm";
import type { ShareService } from "./shares";

/**
 * A document opened by someone it was shared with (DESIGN.md §12, ROADMAP 1c.2): `/doc/<id>` for a signed-in account that has
 * a named share on it, with no connection of its own. The share names the connection and the Doc `id`, not the path, so the
 * document is found as it is now, wherever it has been moved to; it is read with the owner's token and shown as it is in the
 * repository (a draft the owner has not saved as a version is not shown). The policy is asked, for the role the share has,
 * whether it may read, and what the share does not name is never shown: not the rest of the repository, not the path. (Finding the document by its `id`
 * reads the headers of the repository's other Markdown files, as every lookup by id does (`browse/ids.ts`); none of that is shown.)
 */
export interface OpenDeps {
  shares: Pick<ShareService, "find">;
  /** The repository of a connection as it is now, read with its owner's token; undefined if it cannot be read. */
  sourceOf: (connectionId: number) => Promise<Source | undefined>;
  index: DocIndex;
  format: Pick<Fjord, "parseDocument" | "impliedTitle">;
  /** Who shared it, by account: their name, if the account is still there. */
  nameOf: (accountId: string) => Promise<string | undefined>;
  now?: () => number;
}

export interface SharedDocument {
  title: string;
  /** The Markdown after the header, which is not shown. A header that cannot be read leaves the whole file. */
  body: string;
  role: Role;
  sharedBy: string | undefined;
}

export async function openShared(deps: OpenDeps, accountId: string, docId: string): Promise<SharedDocument | undefined> {
  const now = deps.now?.() ?? Date.now();
  for (const share of await deps.shares.find(accountId, docId)) {
    if (decide([{ kind: "user", role: share.role }], "read", { kind: "document" }, now) !== "allow") continue;
    const source = await deps.sourceOf(share.connectionId);
    if (!source) continue;
    const { matches } = await resolveDocId({ index: deps.index, format: deps.format }, [source], docId);
    // Only a document is shared: a note that has the id is not what was shared.
    const match = matches.find((candidate) => candidate.kind === "document");
    const blob = match ? source.read.blobs.get(match.path) : undefined;
    if (!match || blob === undefined) continue;
    const text = await readTextBlob(source.provider, source.ref, blob);
    if (!text.ok) continue;
    const start = bodyStartOf(deps.format, text.text);
    const parsed = deps.format.parseDocument(text.text);
    const title = (parsed.title ?? "").trim() || deps.format.impliedTitle(text.text, match.path.slice(match.path.lastIndexOf("/") + 1));
    return { title, body: start === undefined ? text.text : text.text.slice(start), role: share.role, sharedBy: await deps.nameOf(share.sharedBy) };
  }
  return undefined;
}
