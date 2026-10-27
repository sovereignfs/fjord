import { createHash } from "node:crypto";
import { isProviderError } from "../providers/errors";
import type { Identity, Provider, RepositoryRef } from "../providers/types";
import type { Editor, WorkingCopyService } from "./service";

/**
 * Making a version of a note from its draft (DESIGN.md §11, ROADMAP 1b.9): one commit, through the owner's connection, on
 * the branch the note was opened from.
 *
 *  - **Only on top of the draft's base.** The commit is made if the file at the branch's head is still the blob the draft
 *    was started from. If it is not (someone committed from the CLI, Obsidian or another device) or the file is gone,
 *    nothing is written and the draft is kept: choosing between the two is 1b.10. A head that moved without touching the
 *    file is no reason to refuse: it is read again, once, and the commit goes on top of the new head. It is never forced.
 *  - **The saver is the author**; everyone else who edited since the last version is credited with a `Co-authored-by:`
 *    trailer, as an account that no longer exists is not.
 *  - **The draft ends with the version**, unless something was typed into it while the commit was being made: that is
 *    not in the version, and is not thrown away.
 */
export interface VersionDeps {
  drafts: Pick<WorkingCopyService, "get" | "discardUnchanged">;
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  /** Who an editor of the draft is, as a commit names them; undefined if they cannot be found any more. */
  identityOf: (editor: Editor) => Promise<Identity | undefined>;
}

export type VersionResult =
  | { ok: true; commit: string }
  | { ok: false; reason: "no_draft" | "nothing_to_save" | "upstream_changed" | "gone" | "head_moved" | "read_only" | "bad_token" | "unavailable" };

export { MAX_MESSAGE_CHARS } from "./limits";
/** A head that moved is read again this many times before giving up. */
const ATTEMPTS = 2;

/** `Edit <title>`: a note or a document is known by its file name without the extension (`.fj.md` for a document). */
export function defaultMessage(path: string): string {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return `Edit ${leaf.replace(/\.fj\.md$/i, "").replace(/\.md$/i, "")}`;
}

/**
 * How a version credits someone who edited through a link (ROADMAP 1c.6): by the display name they gave, with an address that is
 * nobody's, under the reserved `.invalid` domain, made from the link and the name so that two names on one link are two credits.
 * The address is in the repository's history, so it says nothing about who they are.
 */
export function guestIdentity(editor: { link: number; name: string }): Identity {
  const hash = createHash("sha256").update(editor.name, "utf8").digest("hex").slice(0, 8);
  return { name: editor.name, email: `link-${editor.link}-${hash}@users.noreply.fjord.invalid` };
}

/** A name or an address as git writes it: no angle brackets, no line breaks, no stray whitespace. */
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();

export function formatIdentity(identity: Identity): Identity {
  const email = clean(identity.email).replace(/\s/g, "");
  return { name: clean(identity.name) || email.split("@")[0] || "Unknown", email };
}

/**
 * The commit message: what the person wrote (else the default), then one `Co-authored-by:` line per other editor after a
 * blank line, which is where git reads trailers.
 */
export function composeMessage(path: string, wanted: string | undefined, coAuthors: Identity[]): string {
  const subject = (wanted ?? "").replace(/\r\n?/g, "\n").trim() || defaultMessage(path);
  if (coAuthors.length === 0) return subject;
  return `${subject}\n\n${coAuthors.map((who) => `Co-authored-by: ${who.name} <${who.email}>`).join("\n")}`;
}

/** The file's blob at a commit, or undefined if there is no file there (a symbolic link or a folder is not a note to replace). */
export async function blobAt(provider: Provider, ref: RepositoryRef, commit: string, path: string): Promise<string | undefined> {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const entries = await provider.listDirectory(ref, commit, directory).catch((error: unknown) => {
    if (isProviderError(error, "not_found")) return [];
    throw error;
  });
  return entries.find((entry) => entry.path === path && entry.kind === "file")?.id;
}

export async function saveVersion(deps: VersionDeps, input: { connectionId: number; path: string; message?: string | undefined; author: Identity; authorId: string }): Promise<VersionResult> {
  const draft = await deps.drafts.get(input.connectionId, input.path);
  if (!draft) return { ok: false, reason: "no_draft" };

  const author = formatIdentity(input.author);
  const coAuthors: Identity[] = [];
  for (const editor of draft.editors) {
    if (editor.type === "account" && editor.id === input.authorId) continue;
    const who = await deps.identityOf(editor);
    if (!who) continue;
    const named = formatIdentity(who);
    if (named.email === author.email || coAuthors.some((other) => other.email === named.email)) continue;
    coAuthors.push(named);
  }
  const message = composeMessage(input.path, input.message, coAuthors);

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const current = await blobAt(deps.provider, deps.ref, expectedHead, input.path);
      if (current === undefined) return { ok: false, reason: "gone" };
      if (current !== draft.baseBlob) return { ok: false, reason: "upstream_changed" };

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message,
          author,
          changes: [{ path: input.path, content: new TextEncoder().encode(draft.content) }],
        });
        // The version exists whatever happens to the draft: if it cannot be removed it stays, the same text as the file.
        await deps.drafts.discardUnchanged(input.connectionId, input.path, draft.lastEdit).catch(() => console.error("[fjord] versions: a draft could not be removed after its version was made"));
        return { ok: true, commit: made.commit };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, "no_changes")) {
      // The draft is the file as it is: there is nothing to make a version of, and nothing to keep.
      await deps.drafts.discardUnchanged(input.connectionId, input.path, draft.lastEdit);
      return { ok: false, reason: "nothing_to_save" };
    }
    if (isProviderError(error, "forbidden")) return { ok: false, reason: "read_only" };
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}
