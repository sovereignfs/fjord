import { locateInRepository, readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import type { ManageDeps, OpenDeps } from "./http";
import { SealedShareService } from "./service";

const sealed = async () => new SealedShareService(await getDatabase());

/** Whether `path` of the connection is, now, an encrypted payload of an encrypted vault: the only thing a sealed share is a copy of. */
async function isEncryptedFile(accountId: string, id: number, path: string): Promise<"yes" | "no" | "unavailable"> {
  const connection = await (await connectionService()).get(accountId, id);
  if (!connection) return "no";
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return outcome.problem.code === "not_found" ? "no" : "unavailable";
  const found = await locateInRepository(accountId, connection, outcome.read, path.split("/"));
  if (!found.ok) return "unavailable";
  return found.location.kind === "file" && found.location.file.kind === "payload" && found.location.vault.encrypted === true ? "yes" : "no";
}

const owns = async (accountId: string, id: number) => (await (await connectionService()).get(accountId, id)) !== undefined;

export const manageDeps = (origin: string, userId: string): ManageDeps => ({
  origin,
  list: async (accountId, id, path) => ((await owns(accountId, id)) ? { found: true, shares: await (await sealed()).list(id, path) } : { found: false }),
  create: async (accountId, id, input) => {
    if (!(await owns(accountId, id))) return { found: false };
    const encrypted = await isEncryptedFile(accountId, id, input.path);
    if (encrypted !== "yes") return { found: true, result: { ok: false, reason: encrypted === "no" ? "not_encrypted" : "unavailable" } };
    return { found: true, result: await (await sealed()).create(id, { ...input, createdBy: userId }) };
  },
  revoke: async (accountId, id, shareId) => ((await owns(accountId, id)) ? { found: true, revoked: await (await sealed()).revoke(id, shareId) } : { found: false }),
});

export const openDeps: OpenDeps = { read: async (token) => (await sealed()).byToken(token) };
