import { type Role, decide } from "../access/policy";
import { bodyStartOf } from "../browse/document";
import type { DocIndex } from "../browse/doc-index";
import { resolveDocId, type Source } from "../browse/ids";
import { readTextBlob } from "../browse/note";
import type { Fjord } from "../format/wasm";
import type { LinkService } from "./links";
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

/** The document with this Doc `id` in one connection's repository as it is now: its title and body, or undefined. */
async function readDocument(deps: Pick<OpenDeps, "sourceOf" | "index" | "format">, connectionId: number, docId: string): Promise<{ title: string; body: string } | undefined> {
  const source = await deps.sourceOf(connectionId);
  if (!source) return undefined;
  const { matches } = await resolveDocId({ index: deps.index, format: deps.format }, [source], docId);
  // Only a document is shared: a note that has the id is not what was shared.
  const match = matches.find((candidate) => candidate.kind === "document");
  const blob = match ? source.read.blobs.get(match.path) : undefined;
  if (!match || blob === undefined) return undefined;
  const text = await readTextBlob(source.provider, source.ref, blob);
  if (!text.ok) return undefined;
  const start = bodyStartOf(deps.format, text.text);
  const parsed = deps.format.parseDocument(text.text);
  const title = (parsed.title ?? "").trim() || deps.format.impliedTitle(text.text, match.path.slice(match.path.lastIndexOf("/") + 1));
  return { title, body: start === undefined ? text.text : text.text.slice(start) };
}

export async function openShared(deps: OpenDeps, accountId: string, docId: string): Promise<SharedDocument | undefined> {
  const now = deps.now?.() ?? Date.now();
  for (const share of await deps.shares.find(accountId, docId)) {
    if (decide([{ kind: "user", role: share.role }], "read", { kind: "document" }, now) !== "allow") continue;
    const opened = await readDocument(deps, share.connectionId, docId);
    if (opened) return { ...opened, role: share.role, sharedBy: await deps.nameOf(share.sharedBy) };
  }
  return undefined;
}

/** What opening by a link needs: where links are kept, and how to read the repository they are of. */
export interface LinkOpenDeps {
  links: Pick<LinkService, "byToken">;
  sourceOf: OpenDeps["sourceOf"];
  index: DocIndex;
  format: OpenDeps["format"];
  now?: () => number;
}

/**
 * The document a link opens (ROADMAP 1c.3), for whoever has it, signed in or not. The token must be one that was made, for **this**
 * document (a link to one document opens no other), and still live: the policy is given the link's role, expiry and revocation,
 * and a link that has expired or been revoked is as if it had never been. Undefined for every one of those, so that nothing says
 * which it was.
 */
export async function openByLink(deps: LinkOpenDeps, token: string, docId: string): Promise<SharedDocument | undefined> {
  const link = await deps.links.byToken(token);
  if (!link || link.docId !== docId) return undefined;
  const grant = { kind: "link", role: link.role, expiresAt: link.expiresAt, revoked: link.revokedAt !== null } as const;
  if (decide([grant], "read", { kind: "document" }, deps.now?.() ?? Date.now()) !== "allow") return undefined;
  const opened = await readDocument(deps, link.connectionId, docId);
  return opened ? { ...opened, role: link.role, sharedBy: undefined } : undefined;
}
