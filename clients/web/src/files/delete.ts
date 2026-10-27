import { MAX_NOTE_BYTES } from "../browse/note";
import { isProviderError } from "../providers/errors";
import type { Fjord } from "../format/wasm";
import type { Identity, Provider, RepositoryRef, TreeEntry } from "../providers/types";
import type { WorkingCopyService } from "../working/service";
import { type VersionResult, formatIdentity } from "../working/version";
import type { DeletionService, NewDeletion } from "./deletions";

/**
 * Deleting a note, a document or a folder of a plaintext vault (DESIGN.md §8, ROADMAP 1b.12): one commit through the owner's
 * token that removes the file, or everything in the folder. Nothing is lost for good: git still has the file in its history,
 * and each deleted file is recorded (`deletions.ts`) so that **Undo** and **Recently deleted** can put it back.
 *
 *  - **What the person confirmed is what goes.** A file is deleted only if it is still the blob the page showed; a folder
 *    only if it still holds the number of files the confirmation named. Otherwise nothing is written and the page looks
 *    again. The commit goes on top of the head that was read, never forced; a head that moved is read again once.
 *  - **Unsaved changes are not thrown away.** A file with a draft has it saved as a version first (§11), so the deletion is
 *    committed on top of what the person had; if that cannot be done nothing is deleted. A folder with drafts in it is
 *    refused: save or discard them first.
 *  - **Not the vault's own files.** A vault, its manifest and `fjord.json` belong to the CLI in phase 1 and are never
 *    deleted from here.
 */
export interface DeleteDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "parseDocument">;
  deletions: Pick<DeletionService, "record">;
  drafts: Pick<WorkingCopyService, "paths">;
  /** Make a version of the draft of this file, so that it is not lost in the deletion. */
  saveDraft: (path: string) => Promise<VersionResult>;
  /** For tests: the most files one deletion takes. */
  maxFiles?: number;
}

export type DeleteTarget = { type: "file"; path: string; blob: string } | { type: "folder"; path: string; files: number };

export type DeleteResult =
  | { ok: true; commit: string; files: number; deletions: number[] }
  | {
      ok: false;
      reason: "gone" | "upstream_changed" | "folder_changed" | "too_many" | "has_drafts" | "draft_not_saved" | "protected" | "head_moved" | "read_only" | "bad_token" | "unavailable";
      /** For `has_drafts`: how many files in the folder have one. For `draft_not_saved`: why the version was not made. */
      detail?: number | string;
    };

/** The most files one deletion takes; a larger folder is deleted from the CLI. */
export const MAX_FILES_PER_DELETE = 1000;
const ATTEMPTS = 2;
const MACHINERY = new Set(["fjord.vault.json", "fjord.json"]);

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The name a person knows a deleted path by: a file without its extension, a folder as it is. */
export function deletedName(path: string): string {
  return leaf(path).replace(/\.fj\.md$/i, "").replace(/\.md$/i, "");
}

export async function deletePath(
  deps: DeleteDeps,
  input: { connectionId: number; accountId: string; vault: string; target: DeleteTarget; kindOf: (path: string) => NewDeletion["kind"]; author: Identity },
): Promise<DeleteResult> {
  const { target } = input;
  // Inside the vault and not the vault itself.
  if (!target.path.startsWith(`${input.vault}/`) || target.path.length === input.vault.length + 1) return { ok: false, reason: "protected" };

  // Unsaved changes first: they are saved as a version, which changes the file, so what the page showed no longer applies.
  let expectedBlob: string | undefined = target.type === "file" ? target.blob : undefined;
  const drafts = await deps.drafts.paths(input.connectionId);
  if (target.type === "file" && drafts.includes(target.path)) {
    const saved = await deps.saveDraft(target.path);
    if (!saved.ok) return { ok: false, reason: "draft_not_saved", detail: saved.reason };
    expectedBlob = undefined; // taken from the file as it is after the version, and held to on a second look
  }
  if (target.type === "folder") {
    const inside = drafts.filter((path) => path.startsWith(`${target.path}/`));
    if (inside.length > 0) return { ok: false, reason: "has_drafts", detail: inside.length };
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      let files: TreeEntry[];
      if (target.type === "file") {
        const entry = await fileAt(deps.provider, deps.ref, expectedHead, target.path);
        if (!entry) return { ok: false, reason: "gone" };
        expectedBlob ??= entry.id;
        if (entry.id !== expectedBlob) return { ok: false, reason: "upstream_changed" };
        files = [entry];
      } else {
        const found = await filesUnder(deps.provider, deps.ref, expectedHead, target.path, deps.maxFiles ?? MAX_FILES_PER_DELETE);
        if (found === "too_many") return { ok: false, reason: "too_many" };
        if (found.length === 0) return { ok: false, reason: "gone" };
        if (found.length !== target.files) return { ok: false, reason: "folder_changed", detail: found.length };
        files = found;
      }
      if (files.some((file) => MACHINERY.has(leaf(file.path)))) return { ok: false, reason: "protected" };

      const entries: NewDeletion[] = [];
      for (const file of files) entries.push({ path: file.path, kind: input.kindOf(file.path), blob: file.id });
      if (target.type === "file" && entries[0]!.kind !== "other") entries[0]!.docId = await docIdOf(deps, files[0]!.id);

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: `Delete ${deletedName(target.path)}${files.length > 1 ? `\n\nRemoves ${files.length} files.` : ""}`,
          author: formatIdentity(input.author),
          changes: files.map((file) => ({ path: file.path, delete: true as const })),
        });
        // The deletion stands whatever happens to its record; without one only Undo is lost, and the history has the file.
        const deletions = await deps.deletions.record(input.connectionId, made.commit, input.accountId, entries).catch(() => {
          console.error("[fjord] files: a deletion could not be recorded");
          return [] as number[];
        });
        return { ok: true, commit: made.commit, files: files.length, deletions };
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

/** The file at a path at a commit, as its directory lists it (a folder or a link there is not a file to delete). */
async function fileAt(provider: Provider, ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry | undefined> {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const entries = await provider.listDirectory(ref, commit, directory).catch((error: unknown) => {
    if (isProviderError(error, "not_found")) return [] as TreeEntry[];
    throw error;
  });
  return entries.find((entry) => entry.path === path && entry.kind === "file");
}

/**
 * Every file under a folder at a commit, or "too_many". Links count as files (git stores them as such); a submodule is not
 * ours to delete and is left out. One request for the whole tree when the host gives it, else folder by folder.
 */
export async function filesUnder(provider: Provider, ref: RepositoryRef, commit: string, folder: string, limit: number): Promise<TreeEntry[] | "too_many"> {
  const tree = await provider.getTree(ref, commit);
  const isFile = (entry: TreeEntry) => entry.kind === "file" || entry.kind === "symlink";
  if (tree.complete) {
    const found = tree.entries.filter((entry) => isFile(entry) && entry.path.startsWith(`${folder}/`));
    return found.length > limit ? "too_many" : found;
  }
  const found: TreeEntry[] = [];
  const pending = [folder];
  for (let directory = pending.shift(); directory !== undefined; directory = pending.shift()) {
    const entries = await provider.listDirectory(ref, commit, directory).catch((error: unknown) => {
      if (isProviderError(error, "not_found")) return [] as TreeEntry[];
      throw error;
    });
    for (const entry of entries) {
      if (entry.kind === "directory") pending.push(entry.path);
      else if (isFile(entry)) found.push(entry);
      if (found.length > limit) return "too_many";
    }
  }
  return found;
}

/** The Doc's `id` a file's header names, if it can be read and has one. */
async function docIdOf(deps: DeleteDeps, blob: string): Promise<string | null> {
  try {
    const bytes = await deps.provider.readBlob(deps.ref, blob, { maxBytes: MAX_NOTE_BYTES });
    const parsed = deps.format.parseDocument(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    return parsed.status === "present" ? (parsed.docId ?? null) : null;
  } catch (error) {
    if (isProviderError(error, "too_large") || error instanceof TypeError) return null; // not text, or too large to be a note
    throw error;
  }
}
