import { authConfig, getSession } from "../auth/server";
import { connectionService } from "../connections/server";
import { fjord } from "../format/wasm";
import { createLocalRepository } from "./create";
import type { LocalDeps } from "./http";
import { syncToGitHub } from "./sync";
import type { Caller } from "../connections/http";

/** Who is calling, and what `http.ts` needs: the same as `connections/context.ts`, for the routes of repositories on this server. Null when the instance has no sign-in at all. */
export async function localContext(): Promise<{ caller: Caller | null; deps: LocalDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return {
    caller: session ? { accountId: session.user.id } : null,
    deps: {
      origin: config.url,
      create: async (accountId, input) => createLocalRepository({ service: await connectionService(), format: fjord() }, accountId, input),
      usage: async (accountId) => (await connectionService()).localUsage(accountId),
      sync: async (accountId, id, input) => {
        const service = await connectionService();
        return (await service.get(accountId, id)) ? syncToGitHub(service, accountId, id, input) : undefined;
      },
    },
  };
}
