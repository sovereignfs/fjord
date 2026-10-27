import { DocIndex } from "../browse/doc-index";
import { resolveDocId } from "../browse/ids";
import { readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import type { Identity } from "../providers/types";
import { makeVersion } from "../working/server";
import { WorkingCopyService } from "../working/service";
import { type AccessDeps, filesAccess } from "./access";
import { restoreWindowMs } from "./config";
import { type CreateResult, type FileKind, checkVault, createFile } from "./create";
import { type DeleteResult, type DeleteTarget, deletePath } from "./delete";
import { DeletionService } from "./deletions";
import { type MoveResult, movePath } from "./move";
import { type RestoreResult, restoreDeleted } from "./restore";

/** Whether files may be made in a vault of one of the account's repositories, as the repository is now. */
async function vaultFor(accountId: string, id: number, vault: string): Promise<"ok" | ReturnType<typeof checkVault> | "unavailable"> {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return "unavailable";
  const outcome = await readConnection(accountId, connection);
  return outcome.ok ? checkVault(outcome.read.discovery.vaults, vault) : "unavailable";
}

/** Make a file in one of the account's repositories: through the connection's own token, on the branch it was connected with. */
async function create(
  accountId: string,
  id: number,
  input: { vault: string; folder: string; kind: FileKind; title: string; localMinute: { year: number; month: number; day: number; hour: number; minute: number }; author: Identity },
): Promise<CreateResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  return createFile(
    { provider: used.provider, ref: { owner: used.connection.owner, name: used.connection.name }, branch: used.connection.branch, format: fjord() },
    input,
  );
}

/** Delete from one of the account's repositories: through its own token, on its branch, saving unsaved changes as a version first. */
async function remove(accountId: string, id: number, input: { vault: string; target: DeleteTarget; author: Identity }): Promise<DeleteResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  const outcome = await readConnection(accountId, used.connection);
  // What a deleted file was called by its name, as the format module classified it; a repository too large to list says "other".
  const kinds = new Map<string, "note" | "document">();
  if (outcome.ok) {
    for (const vault of outcome.read.discovery.vaults) for (const file of vault.files) if (file.kind === "note" || file.kind === "document") kinds.set(file.path, file.kind);
  }
  const database = await getDatabase();
  return deletePath(
    {
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      format: fjord(),
      deletions: new DeletionService(database),
      drafts: new WorkingCopyService(database),
      saveDraft: (path) => makeVersion(accountId, id, { path, message: undefined, author: input.author }),
    },
    { connectionId: id, accountId, vault: input.vault, target: input.target, kindOf: (path) => kinds.get(path) ?? "other", author: input.author },
  );
}

/** Rename or move in one of the account's repositories: through its own token, on its branch, saving unsaved changes first. */
async function move(accountId: string, id: number, input: { vault: string; target: DeleteTarget; destination: string; author: Identity }): Promise<MoveResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  const database = await getDatabase();
  const result = await movePath(
    {
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      format: fjord(),
      drafts: new WorkingCopyService(database),
      saveDraft: (path) => makeVersion(accountId, id, { path, message: undefined, author: input.author }),
    },
    { connectionId: id, ...input },
  );
  // What is known of which Doc is where follows the files. The move stands whatever happens to this; the next search finds them.
  if (result.ok) await new DocIndex(database).move(id, result.moved).catch(() => console.error("[fjord] files: the id index could not follow a move"));
  return result;
}

/** Put back deletions of one of the account's repositories, into the vaults it can still write to. */
async function restore(accountId: string, id: number, input: { ids: number[]; path: string | undefined; author: Identity }): Promise<RestoreResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  const outcome = await readConnection(accountId, used.connection);
  if (!outcome.ok) return { ok: false, reason: "unavailable" };
  const vaults = outcome.read.discovery.vaults;
  return restoreDeleted(
    {
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      format: fjord(),
      deletions: new DeletionService(await getDatabase()),
      vaultOk: (vault) => checkVault(vaults, vault) === "ok",
      idsInUse: async (docIds) => {
        const source = { connectionId: id, ref: { owner: used.connection.owner, name: used.connection.name }, read: outcome.read, provider: used.provider };
        const index = new DocIndex(await getDatabase());
        const found: Record<string, string[]> = {};
        for (const docId of docIds) found[docId] = (await resolveDocId({ index, format: fjord() }, [source], docId)).matches.map((match) => match.path);
        return found;
      },
      windowMs: restoreWindowMs(),
    },
    { connectionId: id, ...input },
  );
}

export async function filesAccessFor(): Promise<ReturnType<typeof filesAccess>> {
  const deps: AccessDeps = {
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    vaultFor,
    setTitle: (header, title) => fjord().withTitle(header, title),
    create,
    delete: remove,
    move,
    restore,
  };
  return filesAccess(deps);
}
