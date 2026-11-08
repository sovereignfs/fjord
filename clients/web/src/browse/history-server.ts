import { authConfig, getSession } from '../auth/server';
import { connectionService } from '../connections/server';
import { versionBytes, versionsOf } from './history';
import type { Caller, HistoryDeps } from './history-http';
import { readConnection } from './server';

/** Is this path inside a vault of the repository as it is now? History is of the files the app shows, and not a second way to read everything in the repository. */
async function reach(accountId: string, id: number, path: string) {
  const service = await connectionService();
  const connection = await service.get(accountId, id);
  if (!connection) return undefined;
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return undefined;
  if (!outcome.read.discovery.vaults.some((vault) => path.startsWith(`${vault.directory}/`)))
    return undefined;
  const used = await service.provider(accountId, id);
  return used
    ? {
        provider: used.provider,
        ref: { owner: connection.owner, name: connection.name },
        head: outcome.read.commit,
      }
    : undefined;
}

/** Who is calling, and what `history-http.ts` needs. Null when no way of signing in is on. */
export async function historyContext(): Promise<{
  caller: Caller | null;
  deps: HistoryDeps;
} | null> {
  if (!authConfig().enabled) return null;
  const session = await getSession();
  return {
    caller: session ? { accountId: session.user.id } : null,
    deps: {
      versions: async (accountId, id, path) => {
        const place = await reach(accountId, id, path);
        if (!place) return { found: false };
        const asked = await versionsOf(place.provider, place.ref, place.head, path);
        return {
          found: true,
          versions: asked?.versions ?? [],
          more: asked?.more ?? false,
          supported: asked !== undefined,
        };
      },
      file: async (accountId, id, path, commit) => {
        const place = await reach(accountId, id, path);
        return place
          ? { found: true, result: await versionBytes(place.provider, place.ref, commit, path) }
          : { found: false };
      },
    },
  };
}
