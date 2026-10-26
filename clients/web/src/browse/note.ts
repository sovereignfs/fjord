import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef } from "../providers/types";
import type { RepositoryRead } from "./repository";

/**
 * A note's text, to show in the editor (ROADMAP 1b.2): exactly the file, as text. The editor is byte-faithful, so what it
 * is given must be too: the file is decoded strictly as UTF-8 with any byte order mark kept, and a file that is not text,
 * or is larger than a note should be, is not shown as one rather than shown changed.
 */
export const MAX_NOTE_BYTES = 1024 * 1024;

export type NoteText =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "not_text" | "gone"; message: string };

const MESSAGES = {
  too_large: "This note is larger than 1 MB, which is more than the editor opens.",
  not_text: "This file is not valid UTF-8 text, so it cannot be shown as a note without changing it.",
  gone: "This note is no longer in the repository.",
} as const;

const refused = (reason: keyof typeof MESSAGES): NoteText => ({ ok: false, reason, message: MESSAGES[reason] });

/** The blob of `path` at the commit that was read: from the listing if it has it, else from its directory. */
async function blobOf(provider: Provider, ref: RepositoryRef, read: RepositoryRead, path: string): Promise<string | undefined> {
  const known = read.blobs.get(path);
  if (known !== undefined) return known;
  // A repository too large to list whole is read a directory at a time, and a file in a deep one is not in the map.
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const entries = await provider.listDirectory(ref, read.commit, directory).catch((error: unknown) => {
    if (isProviderError(error, "not_found")) return [];
    throw error;
  });
  return entries.find((entry) => entry.path === path && (entry.kind === "file" || entry.kind === "symlink"))?.id;
}

export async function readNoteText(provider: Provider, ref: RepositoryRef, read: RepositoryRead, path: string): Promise<NoteText> {
  const blob = await blobOf(provider, ref, read, path);
  if (blob === undefined) return refused("gone");
  let bytes: Uint8Array;
  try {
    bytes = await provider.readBlob(ref, blob, { maxBytes: MAX_NOTE_BYTES });
  } catch (error) {
    if (isProviderError(error, "too_large")) return refused("too_large");
    if (isProviderError(error, "not_found")) return refused("gone");
    throw error;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return refused("not_text");
  }
}
