import { readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { fjord } from "../format/wasm";
import type { Identity } from "../providers/types";
import { type AccessDeps, filesAccess } from "./access";
import { type CreateResult, type FileKind, checkVault, createFile } from "./create";

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

export async function filesAccessFor(): Promise<ReturnType<typeof filesAccess>> {
  const deps: AccessDeps = {
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    vaultFor,
    create,
  };
  return filesAccess(deps);
}
