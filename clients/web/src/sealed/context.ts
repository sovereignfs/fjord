import { authConfig, getSession } from "../auth/server";
import type { Caller, ManageDeps, OpenDeps } from "./http";
import { manageDeps, openDeps } from "./server";

/** Who is calling the owner's side, and what `http.ts` needs. Null when the instance has no sign-in, in which case there are no connections and the route is not there. */
export async function sealedManageContext(): Promise<{ caller: Caller | null; deps: ManageDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return { caller: session ? { accountId: session.user.id, userId: session.user.id } : null, deps: manageDeps(config.url, session?.user.id ?? "") };
}

/** The link's side: nobody is signed in to follow a link, and the route is there whether or not the instance has sign-in. */
export function sealedOpenContext(): { deps: OpenDeps } {
  return { deps: openDeps };
}
