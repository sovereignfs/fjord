import { isProviderError } from "../providers/errors";
import { assertWritablePath } from "../providers/validate";
import type { Fjord } from "../format/wasm";
import type { Change, Identity, Provider, RepositoryRef, TreeEntry } from "../providers/types";
import type { WorkingCopyService } from "../working/service";
import { type VersionResult, formatIdentity } from "../working/version";
import { type DeleteTarget, deletedName, fileAt, filesUnder } from "./delete";
import { suffix, takenPaths } from "./restore";

/**
 * Renaming and moving a note, a document or a folder of a plaintext vault (DESIGN.md §8, ROADMAP 1b.11): one commit through
 * the owner's token that takes the files from their old paths and puts the **same blobs** at the new ones. Nothing is
 * rewritten, so a Doc's `id`, its header and every byte of it are as they were (spec §8.2: a rename is not an edit), and
 * the `id` routes, shares and comments that follow an `id` need nothing from a move.
 *
 *  - **What the person was shown is what moves.** As for deleting: a file only if it is still the blob shown, a folder only
 *    if it still holds the files the page counted; otherwise nothing is written and the page looks again. On top of the head
 *    that was read, never forced; a head that moved is read again once.
 *  - **Names are `fjord-core`'s.** Every segment of the new path passes the path rules of spec §5, and no two names in a
 *    folder differ only by case. **Never over anything:** a new path that is taken, or has a file or a name like it in the
 *    way, is refused and named. A file renamed to a name that differs from its own only by case is not in its own way.
 *  - **The extension stays**, so a document never becomes a note or back. A folder is never moved into itself, a vault, its
 *    manifest and `fjord.json` are not touched, and a file that git stores as a link is not moved (a commit of a blob cannot
 *    say it is one).
 *  - **Unsaved changes are not lost.** A file with a draft has it saved as a version first (§11), then moved; a folder with
 *    drafts in it is refused, and so is a place that has one.
 *  - Only the destination's vault being plaintext is the caller's to have checked (`access.ts`): this is given paths.
 */
export interface MoveDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "checkName" | "caseCollisions">;
  drafts: Pick<WorkingCopyService, "paths">;
  /** Make a version of the draft of this file, so that it is not lost in the move. */
  saveDraft: (path: string) => Promise<VersionResult>;
  /** For tests: the most files one move takes. */
  maxFiles?: number;
}

export type MoveResult =
  | { ok: true; commit: string; files: number; moved: { from: string; to: string }[] }
  | {
      ok: false;
      reason:
        | "gone"
        | "upstream_changed"
        | "folder_changed"
        | "too_many"
        | "has_drafts"
        | "draft_not_saved"
        | "protected"
        | "bad_path"
        | "extension_changed"
        | "into_itself"
        | "unchanged"
        | "path_taken"
        | "head_moved"
        | "read_only"
        | "bad_token"
        | "unavailable";
      /** For `has_drafts`: how many files. For `draft_not_saved`: why. */
      detail?: number | string;
      /** For `path_taken`: the paths that are. */
      taken?: string[];
    };

export { MAX_FILES_PER_DELETE as MAX_FILES_PER_MOVE } from "./delete";
const ATTEMPTS = 2;
const MACHINERY = new Set(["fjord.vault.json", "fjord.json"]);
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function writable(path: string): boolean {
  try {
    assertWritablePath(path);
    return true;
  } catch {
    return false;
  }
}

/** The message of the commit: a rename keeps the folder, a move changes it. */
export function moveMessage(source: string, destination: string, files: number, folder: boolean): string {
  const name = (path: string) => (folder ? leaf(path) : deletedName(path));
  const title =
    parent(source) === parent(destination)
      ? `Rename ${name(source)} to ${name(destination)}`
      : leaf(source) === leaf(destination)
        ? `Move ${name(source)} to ${parent(destination)}`
        : `Move ${source} to ${destination}`;
  return files > 1 ? `${title}\n\nMoves ${files} files.` : title;
}

export async function movePath(
  deps: MoveDeps,
  input: { connectionId: number; vault: string; target: DeleteTarget; destination: string; author: Identity },
): Promise<MoveResult> {
  const { target, destination } = input;
  const source = target.path;
  // Inside the vault and not the vault itself; the new place is inside a vault too, under a name of its own.
  if (!source.startsWith(`${input.vault}/`) || source.length === input.vault.length + 1) return { ok: false, reason: "protected" };
  const segments = destination.split("/");
  if (segments.length < 2 || !writable(destination)) return { ok: false, reason: "bad_path" };
  if (segments.some((segment) => deps.format.checkName(segment).length > 0)) return { ok: false, reason: "bad_path" };
  if (MACHINERY.has(leaf(destination))) return { ok: false, reason: "protected" };
  if (destination === source) return { ok: false, reason: "unchanged" };
  if (destination.startsWith(`${source}/`)) return { ok: false, reason: "into_itself" };
  if (target.type === "file" && suffix(destination) !== suffix(source)) return { ok: false, reason: "extension_changed" };

  // Unsaved changes first: they become a version, which changes the file, so what the page showed no longer applies.
  let expectedBlob: string | undefined = target.type === "file" ? target.blob : undefined;
  const drafts = await deps.drafts.paths(input.connectionId);
  if (drafts.some((path) => path === destination || path.startsWith(`${destination}/`))) return { ok: false, reason: "path_taken", taken: [destination] };
  if (target.type === "file" && drafts.includes(source)) {
    const saved = await deps.saveDraft(source);
    if (!saved.ok) return { ok: false, reason: "draft_not_saved", detail: saved.reason };
    expectedBlob = undefined;
  }
  if (target.type === "folder") {
    const inside = drafts.filter((path) => path.startsWith(`${source}/`));
    if (inside.length > 0) return { ok: false, reason: "has_drafts", detail: inside.length };
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      let files: TreeEntry[];
      if (target.type === "file") {
        const entry = await fileAt(deps.provider, deps.ref, expectedHead, source);
        if (!entry) return { ok: false, reason: "gone" };
        expectedBlob ??= entry.id;
        if (entry.id !== expectedBlob) return { ok: false, reason: "upstream_changed" };
        files = [entry];
      } else {
        const found = await filesUnder(deps.provider, deps.ref, expectedHead, source, deps.maxFiles ?? MAX_FILES);
        if (found === "too_many") return { ok: false, reason: "too_many" };
        if (found.length === 0) return { ok: false, reason: "gone" };
        if (found.length !== target.files) return { ok: false, reason: "folder_changed", detail: found.length };
        files = found;
      }
      if (files.some((file) => MACHINERY.has(leaf(file.path)) || file.kind !== "file")) return { ok: false, reason: "protected" };

      // The new place is free, apart from what this commit takes away; a folder's files go to the same names in a new folder,
      // which must not be there already (that would be a merge, and nothing here merges).
      const taken = await takenPaths(deps, expectedHead, [destination], new Set([source]));
      if (taken.length > 0) return { ok: false, reason: "path_taken", taken };

      const moved = files.map((file) => ({ from: file.path, to: `${destination}${file.path.slice(source.length)}`, file }));
      const changes: Change[] = [
        ...moved.map(({ from }) => ({ path: from, delete: true as const })),
        ...moved.map(({ to, file }) => ({ path: to, blob: file.id, ...(file.executable ? { executable: true } : {}) })),
      ];
      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: moveMessage(source, destination, files.length, target.type === "folder"),
          author: formatIdentity(input.author),
          changes,
        });
        return { ok: true, commit: made.commit, files: files.length, moved: moved.map(({ from, to }) => ({ from, to })) };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        throw error;
      }
    }
  } catch (error) {
    if (isProviderError(error, "forbidden")) return { ok: false, reason: "read_only" };
    if (isProviderError(error, "unauthorized")) return { ok: false, reason: "bad_token" };
    if (isProviderError(error, "not_found") || isProviderError(error, "unavailable") || isProviderError(error, "rate_limited")) return { ok: false, reason: "unavailable" };
    throw error;
  }
}

const MAX_FILES = 1000;
