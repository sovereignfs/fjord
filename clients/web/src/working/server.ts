import { locateInRepository, readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import { type AccessDeps, workingCopyAccess } from "./access";
import { WorkingCopyService } from "./service";

/** The server's drafts, for routes and pages: the app's database. Never for a test, which builds its own. */
export async function workingCopyService(): Promise<WorkingCopyService> {
  return new WorkingCopyService(await getDatabase());
}

/** Whether `path` of one of the account's repositories is, now, a note in a plaintext vault: what the host says, through the same reading the pages use. */
async function editableNote(accountId: string, id: number, path: string): Promise<"yes" | "no" | "unavailable"> {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return "no";
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return outcome.problem.code === "not_found" ? "no" : "unavailable";
  const found = await locateInRepository(accountId, connection, outcome.read, path.split("/"));
  if (!found.ok) return "unavailable";
  const { location } = found;
  return location.kind === "file" && location.file.kind === "note" && location.vault.encrypted === false ? "yes" : "no";
}

export async function workingCopyAccessFor(): Promise<ReturnType<typeof workingCopyAccess>> {
  const deps: AccessDeps = {
    service: await workingCopyService(),
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    editableNote,
  };
  return workingCopyAccess(deps);
}
