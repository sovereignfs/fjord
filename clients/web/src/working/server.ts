import { locateInRepository, readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { findUser } from "../auth/users";
import { getAuthDatabase, getDatabase } from "../db/boot";
import type { Identity } from "../providers/types";
import { type AccessDeps, workingCopyAccess } from "./access";
import { WorkingCopyService } from "./service";
import { type VersionResult, saveVersion } from "./version";

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

/** Make a version of one of the account's drafts: through the connection's own token, on the branch it was connected with. */
async function makeVersion(accountId: string, id: number, input: { path: string; message: string | undefined; author: Identity }): Promise<VersionResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  const accounts = await getAuthDatabase();
  return saveVersion(
    {
      drafts: await workingCopyService(),
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      identityOf: async (editor) => (editor.type === "account" ? findUser(accounts, editor.id) : undefined),
    },
    { connectionId: id, path: input.path, message: input.message, author: input.author, authorId: accountId },
  );
}

export async function workingCopyAccessFor(): Promise<ReturnType<typeof workingCopyAccess>> {
  const deps: AccessDeps = {
    service: await workingCopyService(),
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    editableNote,
    version: makeVersion,
  };
  return workingCopyAccess(deps);
}
