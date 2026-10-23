import { authConfig, getSession } from "../auth/server";
import { connectionService } from "./server";
import type { Caller, Deps } from "./http";

/**
 * Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in
 * at all, in which case there are no connections either and the route is not there (404).
 */
export async function connectionContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return {
    caller: session ? { accountId: session.user.id } : null,
    deps: { service: connectionService, origin: config.url },
  };
}
