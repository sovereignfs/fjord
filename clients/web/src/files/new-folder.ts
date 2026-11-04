import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef } from "../providers/types";
import type { Fjord } from "../format/wasm";

/**
 * Making a **new folder** (the owner's request after workstream 0003): git has no empty directories, so a folder cannot be made on its own. It is made by its first file: a
 * person names the folder, and the new document that goes in it (`createFile`, `createEncryptedFile`, told `newFolder`) is what puts it in the repository. That is the only
 * way a folder comes to be, and it is why a "new folder" is never an empty one and is not offered where a new document is not.
 *
 * This is what both make sure of before they commit: that the folder's own name is one the format accepts (spec §5, `checkName`: no separator, no dots at the ends, nothing
 * a file system refuses), that the folder it goes in is there (a new folder is one level at a time: never a chain made by mistake), and that nothing of that name is there
 * already, a file or a folder, case aside (two names that differ only in case are one name, spec §5).
 */
export type NewFolderCheck = { ok: true } | { ok: false; reason: "folder_gone" | "bad_folder_name" | "folder_exists" };

export async function checkNewFolder(
  deps: { provider: Provider; ref: RepositoryRef; format: Pick<Fjord, "checkName"> },
  commit: string,
  directory: string,
): Promise<NewFolderCheck> {
  const slash = directory.lastIndexOf("/");
  const parent = slash === -1 ? "" : directory.slice(0, slash);
  const name = directory.slice(slash + 1);
  // A name starting with a dot is not one: `.git` is git's own and a host refuses it, and tools leave the others out of what they list.
  if (name === "" || name.startsWith(".") || deps.format.checkName(name).length > 0) return { ok: false, reason: "bad_folder_name" };
  const siblings = await deps.provider.listDirectory(deps.ref, commit, parent).catch((error: unknown) => {
    if (isProviderError(error, "not_found")) return [];
    throw error;
  });
  // A vault's own top always has its manifest, so a parent with nothing in it is a folder that is not there.
  if (siblings.length === 0) return { ok: false, reason: "folder_gone" };
  const taken = siblings.some((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase() === name.toLowerCase());
  return taken ? { ok: false, reason: "folder_exists" } : { ok: true };
}
