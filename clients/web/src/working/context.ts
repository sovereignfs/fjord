import { authConfig, getSession } from "../auth/server";
import type { Caller, Deps } from "./http";
import { workingCopyAccessFor } from "./server";

/**
 * Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in at all, in which case
 * there are no connections either and the route is not there (404).
 */
export async function workingCopyContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const access = session ? await workingCopyAccessFor() : undefined;
  return {
    caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null,
    deps: {
      origin: config.url,
      save: (accountId, id, input) => (access as NonNullable<typeof access>).save(accountId, id, input),
      discard: (accountId, id, path) => (access as NonNullable<typeof access>).discard(accountId, id, path),
      saveVersion: (accountId, id, input) => (access as NonNullable<typeof access>).saveVersion(accountId, id, input),
      resolve: (accountId, id, input) => (access as NonNullable<typeof access>).resolve(accountId, id, input),
    },
  };
}
