import { authConfig, getSession } from "../auth/server";
import type { Caller } from "../working/http";
import type { Deps } from "./http";
import { filesAccessFor } from "./server";

/**
 * Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in at all, in which case
 * there are no connections either and the route is not there (404).
 */
export async function filesContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const access = session ? await filesAccessFor() : undefined;
  return {
    caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null,
    deps: {
      origin: config.url,
      create: (accountId, id, input) => (access as NonNullable<typeof access>).create(accountId, id, input),
      delete: (accountId, id, input) => (access as NonNullable<typeof access>).delete(accountId, id, input),
      restore: (accountId, id, input) => (access as NonNullable<typeof access>).restore(accountId, id, input),
    },
  };
}
