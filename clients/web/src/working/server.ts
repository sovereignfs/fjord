import { locateInRepository, readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { findUser } from "../auth/users";
import { getAuthDatabase, getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import type { Identity } from "../providers/types";
import { type AccessDeps, workingCopyAccess } from "./access";
import { type WorkingCopy, WorkingCopyService } from "./service";
import { type Choice, type Preview, type ResolveResult, previewCombine, resolveUpstream } from "./resolve";
import { type VersionResult, guestIdentity, saveVersion } from "./version";

/** The server's drafts, for routes and pages: the app's database. Never for a test, which builds its own. */
export async function workingCopyService(): Promise<WorkingCopyService> {
  return new WorkingCopyService(await getDatabase());
}

/** Whether `path` of one of the account's repositories is, now, a note or a document in a plaintext vault: what the host says, through the same reading the pages use. */
async function editableNote(accountId: string, id: number, path: string): Promise<"yes" | "no" | "unavailable"> {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return "no";
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return outcome.problem.code === "not_found" ? "no" : "unavailable";
  const found = await locateInRepository(accountId, connection, outcome.read, path.split("/"));
  if (!found.ok) return "unavailable";
  const { location } = found;
  return location.kind === "file" && (location.file.kind === "note" || location.file.kind === "document") && location.vault.encrypted === false ? "yes" : "no";
}

/** Make a version of one of the account's drafts: through the connection's own token, on the branch it was connected with. */
export async function makeVersion(accountId: string, id: number, input: { path: string; message: string | undefined; author: Identity }): Promise<VersionResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  const accounts = await getAuthDatabase();
  return saveVersion(
    {
      drafts: await workingCopyService(),
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      identityOf: async (editor) => (editor.type === "account" ? findUser(accounts, editor.id) : guestIdentity(editor)),
    },
    { connectionId: id, path: input.path, message: input.message, author: input.author, authorId: accountId },
  );
}

/** Move one of the account's drafts onto the file as it now is: through the connection's own token, on its branch. */
async function makeResolve(accountId: string, id: number, input: { path: string; choice: Choice; upstreamBlob: string }): Promise<ResolveResult> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { ok: false, reason: "unavailable" };
  return resolveUpstream(
    {
      drafts: await workingCopyService(),
      provider: used.provider,
      ref: { owner: used.connection.owner, name: used.connection.name },
      branch: used.connection.branch,
      format: fjord(),
    },
    { connectionId: id, ...input, editor: { type: "account", id: accountId } },
  );
}

/** For a note whose draft is of an older version than the repository has: whether the two combine, found without changing anything. */
export async function previewCombineFor(accountId: string, connectionId: number, draft: WorkingCopy, upstreamText: string): Promise<Preview> {
  const used = await (await connectionService()).provider(accountId, connectionId);
  if (!used) return { state: "unavailable" };
  return previewCombine(used.provider, { owner: used.connection.owner, name: used.connection.name }, fjord(), draft, upstreamText);
}

export async function workingCopyAccessFor(): Promise<ReturnType<typeof workingCopyAccess>> {
  const deps: AccessDeps = {
    service: await workingCopyService(),
    owns: async (accountId, id) => (await (await connectionService()).get(accountId, id)) !== undefined,
    editableNote,
    version: makeVersion,
    resolve: makeResolve,
  };
  return workingCopyAccess(deps);
}
