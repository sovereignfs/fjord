import type { Fjord } from "../format/wasm";
import { isProviderError } from "../providers/errors";
import { assertWritablePath } from "../providers/validate";
import type { Identity, Provider, RepositoryRef, TreeEntry } from "../providers/types";
import { formatIdentity } from "../working/version";
import { deletedName } from "./delete";
import type { DeletionRecord, DeletionService } from "./deletions";

/**
 * Putting back what was deleted (DESIGN.md §8, ROADMAP 1b.12): one commit that adds the files' last blobs back, at the paths
 * they had or, for a single file, at one the person chooses. This is **Undo** (straight after a deletion) and **Recently
 * deleted** (within the restore window).
 *
 *  - **Never over anything.** Every path is checked against the head the commit goes on top of: it must be free, and so must
 *    every folder on the way to it (a file where a folder must go, or a folder where a file must go, is taken), and no name
 *    in that folder may differ from it only by case (spec §5 rule 6). If any path is taken nothing is written and the taken
 *    ones are named.
 *  - **A chosen path keeps what the file is.** Its name is checked by `fjord-core`, it stays in a plaintext vault, and it keeps
 *    its extension, so a document never becomes a note by being put back somewhere else.
 *  - **Not for ever.** A deletion older than the restore window is not offered; git has it still.
 *  - **Never a second file with the same `id`** (spec E401). A deleted document's `id` is kept in its record; if a file in the
 *    repository has it now (a copy made meanwhile, or the document made again from another tool), nothing is put back and
 *    those files are named. That is asked of the id index (1b.6), which looks at what has been read and, if need be, a bounded
 *    share of what has not, so a copy nobody has opened can be missed. Only a single file's deletion records its `id` (a folder's would mean reading every
 *    file in it), so only that is checked; the CLI's `fjord verify` says so if a duplicate gets through.
 */
export interface RestoreDeps {
  provider: Provider;
  ref: RepositoryRef;
  branch: string;
  format: Pick<Fjord, "checkName" | "caseCollisions">;
  deletions: Pick<DeletionService, "get" | "markRestored">;
  /**
   * Where each of these Doc ids is in the repository now: the paths of the files that have it, for the ids that are anywhere.
   * Optional so that a caller with no index restores as it did; the web always gives it.
   */
  idsInUse?: (docIds: string[]) => Promise<Record<string, string[]>>;
  /** Whether files may be put in this vault of the repository now (it is there, and plaintext with plain names, or encrypted as ROADMAP 2b.4 writes). */
  vaultOk: (vault: string) => boolean;
  /** Whether the vault names its files by id: a file there keeps its name when it is put back, since its name is its identifier (spec §7.2). */
  idNamed?: (vault: string) => boolean;
  /** How long after it a deletion is offered, in milliseconds. */
  windowMs: number;
  /** For tests. */
  now?: () => number;
}

export type RestoreResult =
  | { ok: true; commit: string; paths: string[] }
  | {
      ok: false;
      reason: "not_found" | "already_restored" | "expired" | "bad_path" | "vault_unavailable" | "path_taken" | "id_taken" | "blob_gone" | "head_moved" | "read_only" | "bad_token" | "unavailable";
      /** For `path_taken`: the paths that are. For `id_taken`: the files that have the id of what was to be put back. */
      taken?: string[];
    };

const ATTEMPTS = 2;

/**
 * What makes a file what it is: `.fj.md`, else its extension. An encrypted payload is its real file's kind with the `.age` after it
 * (`Plan.md.age`, `Plan.fj.md.age`), so a note never becomes a document, nor either something else, by a rename.
 */
export function suffix(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const payload = /\.age$/i.test(name) && name.length > 4;
  const real = payload ? name.slice(0, -4) : name;
  const kind = /\.fj\.md$/i.test(real) ? ".fj.md" : real.lastIndexOf(".") > 0 ? real.slice(real.lastIndexOf(".")).toLowerCase() : "";
  return payload ? `${kind}.age` : kind;
}

export async function restoreDeleted(deps: RestoreDeps, input: { connectionId: number; ids: number[]; path?: string | undefined; author: Identity }): Promise<RestoreResult> {
  const ids = [...new Set(input.ids)];
  const records = await deps.deletions.get(input.connectionId, ids);
  if (records.length !== ids.length || ids.length === 0) return { ok: false, reason: "not_found" };
  if (records.some((record) => record.restoredAt !== null)) return { ok: false, reason: "already_restored" };
  const now = deps.now?.() ?? Date.now();
  if (records.some((record) => now - record.deletedAt > deps.windowMs)) return { ok: false, reason: "expired" };

  const targets = targetsOf(deps, records, input.path);
  if (typeof targets === "string") return { ok: false, reason: targets };
  if (!targets.every((target) => deps.vaultOk(target.path.split("/")[0] as string))) return { ok: false, reason: "vault_unavailable" };
  // A file of an id-named vault is its identifier: it goes back under that name, in any folder of its vault.
  if (targets.some((target) => deps.idNamed?.(target.path.split("/")[0] as string) && (target.path.slice(target.path.lastIndexOf("/") + 1) !== target.record.path.slice(target.record.path.lastIndexOf("/") + 1) || target.path.split("/")[0] !== target.record.path.split("/")[0]))) {
    return { ok: false, reason: "bad_path" };
  }

  // The id of a document is its own: another file with it would make two Docs of one (spec E401).
  const wanted = [...new Set(records.flatMap((record) => (record.docId === null ? [] : [record.docId])))];
  if (wanted.length > 0 && deps.idsInUse) {
    const inUse = await deps.idsInUse(wanted);
    const holders = [...new Set(wanted.flatMap((docId) => inUse[docId] ?? []))].sort();
    if (holders.length > 0) return { ok: false, reason: "id_taken", taken: holders };
  }

  try {
    for (let attempt = 1; ; attempt++) {
      const head = await deps.provider.getHead(deps.ref, deps.branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const expectedHead = head.head.commit;

      const taken = await takenPaths(deps, expectedHead, targets.map((target) => target.path));
      if (taken.length > 0) return { ok: false, reason: "path_taken", taken };

      try {
        const made = await deps.provider.commit(deps.ref, {
          branch: deps.branch,
          expectedHead,
          message: targets.length === 1 ? `Restore ${deletedName(targets[0]!.path)}` : `Restore ${targets.length} files\n\n${targets.map((target) => target.path).join("\n")}`,
          author: formatIdentity(input.author),
          changes: targets.map((target) => ({ path: target.path, blob: target.record.blob })),
        });
        await deps.deletions.markRestored(input.connectionId, ids).catch(() => console.error("[fjord] files: a restore could not be recorded"));
        return { ok: true, commit: made.commit, paths: targets.map((target) => target.path) };
      } catch (error) {
        if (isProviderError(error, "head_moved")) {
          if (attempt < ATTEMPTS) continue;
          return { ok: false, reason: "head_moved" };
        }
        // The host has no such object any more (history was rewritten): the file cannot be put back from here.
        if (isProviderError(error, "invalid_request")) return { ok: false, reason: "blob_gone" };
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

/** Whether a commit may write this path at all (no empty step, no way up, no `.git`): what every provider asks. */
function writable(path: string): boolean {
  try {
    assertWritablePath(path);
    return true;
  } catch {
    return false;
  }
}

/** Where each record goes: where it was, or the one place chosen for a single file; or why that cannot be. */
function targetsOf(deps: RestoreDeps, records: DeletionRecord[], chosen: string | undefined): { path: string; record: DeletionRecord }[] | "bad_path" {
  // A chosen place is for a single file: given for several, they would all be at it, which the check below for names alike refuses.
  const targets = records.map((record) => ({ path: chosen ?? record.path, record }));
  for (const target of targets) {
    const segments = target.path.split("/");
    if (segments.length < 2 || !writable(target.path) || segments.some((segment) => deps.format.checkName(segment).length > 0)) return "bad_path";
    if (suffix(target.path) !== suffix(target.record.path)) return "bad_path";
  }
  // Two files cannot be put at one path (the plainest pair of names alike), nor at two that differ only by case: a folder
  // deleted with `A.md` and `a.md` in it would put back one name a case-insensitive filesystem cannot hold twice.
  if (deps.format.caseCollisions(targets.map((target) => target.path)).length > 0) return "bad_path";
  return targets;
}

/**
 * The paths, of these, that something is at already, or that cannot be made because something is in the way. `except` names
 * entries (repository-relative paths) that do not count, because the same commit takes them away: a file being renamed does
 * not stand in its own way, so a name that differs from its old one only by case is free.
 */
export async function takenPaths(
  deps: { provider: Provider; ref: RepositoryRef; format: Pick<Fjord, "caseCollisions"> },
  commit: string,
  paths: string[],
  except: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const listings = new Map<string, TreeEntry[]>();
  const list = async (directory: string) => {
    let entries = listings.get(directory);
    if (!entries) {
      entries = await deps.provider.listDirectory(deps.ref, commit, directory).catch((error: unknown) => {
        if (isProviderError(error, "not_found")) return [] as TreeEntry[];
        throw error;
      });
      entries = entries.filter((entry) => !except.has(entry.path));
      listings.set(directory, entries);
    }
    return entries;
  };
  const collides = (name: string, entries: TreeEntry[]) => {
    const names = entries.map((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1));
    return names.some((other) => other === name) || deps.format.caseCollisions([...new Set(names), name]).some((group) => group.includes(name));
  };

  const taken: string[] = [];
  for (const path of paths) {
    const segments = path.split("/");
    let blocked = false;
    for (let i = 0; i < segments.length && !blocked; i++) {
      const directory = segments.slice(0, i).join("/");
      const entries = await list(directory);
      const name = segments[i] as string;
      if (i === segments.length - 1) {
        blocked = collides(name, entries); // the file's own name: anything there, or a name like it, takes it
      } else {
        const same = entries.find((entry) => entry.path === `${directory === "" ? "" : `${directory}/`}${name}`);
        // A folder of that name is where it goes; a file there is in the way; so is a name that differs from it only by case.
        if (same) blocked = same.kind !== "directory";
        else blocked = collides(name, entries);
        if (!same && !blocked) break; // new folders from here on: nothing below can be taken
      }
    }
    if (blocked) taken.push(path);
  }
  return taken;
}
