import { getSession } from "../auth/server";
import { connectionService } from "../connections/server";
import { getDatabase } from "../db/boot";
import { FileHandles } from "./handles";
import { MAX_PAGE_BYTES, type RawDeps } from "./raw";
import { readConnection } from "./server";
import { isProviderError } from "../providers/errors";

/** Who is asking, and what `handleRaw` needs: the handles, and a repository read with its owner's token. */
export async function rawContext(): Promise<{ caller: { accountId: string } | null; deps: RawDeps }> {
  const session = await getSession();
  return {
    caller: session ? { accountId: session.user.id } : null,
    deps: {
      resolve: async (handle) => new FileHandles(await getDatabase()).resolve(handle),
      read: async (accountId, connectionId, path) => {
        // Only this account's own repository.
        const connection = await (await connectionService()).get(accountId, connectionId);
        if (!connection) return { ok: false, reason: "missing" };
        const outcome = await readConnection(accountId, connection);
        if (!outcome.ok) return { ok: false, reason: "missing" };
        const vault = outcome.read.discovery.vaults.find((candidate) => path.startsWith(`${candidate.directory}/`));
        // Not in a vault, or in an encrypted one, where the bytes are not for the server to read: nothing.
        if (!vault || vault.encrypted !== false) return { ok: false, reason: "missing" };
        const blob = outcome.read.blobs.get(path);
        const used = await (await connectionService()).provider(accountId, connectionId);
        if (blob === undefined || !used) return { ok: false, reason: "missing" };
        try {
          return { ok: true, bytes: await used.provider.readBlob({ owner: connection.owner, name: connection.name }, blob, { maxBytes: MAX_PAGE_BYTES }) };
        } catch (error) {
          if (isProviderError(error, "too_large")) return { ok: false, reason: "too_large" };
          if (isProviderError(error, "not_found")) return { ok: false, reason: "missing" };
          throw error;
        }
      },
    },
  };
}
