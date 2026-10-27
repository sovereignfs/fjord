import { authConfig, getSession } from "../auth/server";
import type { Deps } from "./http";
import { sharingAccessFor } from "./server";
import type { Caller } from "../working/http";

/** Who is calling, and what `http.ts` needs to answer them. Null when the instance has no sign-in at all (404). */
export async function sharingContext(): Promise<{ caller: Caller | null; deps: Deps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const access = session ? await sharingAccessFor() : undefined;
  return {
    caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null,
    deps: {
      origin: config.url,
      share: (accountId, id, input) => (access as NonNullable<typeof access>).share(accountId, id, input),
      list: (accountId, id, docId) => (access as NonNullable<typeof access>).list(accountId, id, docId),
      unshare: (accountId, id, input) => (access as NonNullable<typeof access>).unshare(accountId, id, input),
    },
  };
}
