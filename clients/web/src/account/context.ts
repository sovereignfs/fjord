import { getAuthDatabase, getDatabase } from "../db/boot";
import { authConfig, getAuth, getSession, listAccounts } from "../auth/server";
import { connectionService } from "../connections/server";
import { RateLimiter } from "../limits/rate";
import { People } from "../sovereign/people";
import type { AccountDeps, Caller } from "./http";

/** Who is calling, and what `http.ts` needs. Null when no way of signing in is on: there are no accounts to speak of. */
export async function accountContext(): Promise<{ caller: Caller | null; deps: AccountDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const app = await getDatabase();
  return {
    caller: session ? { accountId: session.user.id, email: session.user.email } : null,
    deps: {
      origin: config.url,
      limiter: new RateLimiter(app),
      hasPassword: async () => (await listAccounts()).some((account) => account.providerId === "credential"),
      passwordIs: async (password, request) => {
        const auth = await getAuth();
        if (!auth) return false;
        try {
          return (await auth.api.verifyPassword({ body: { password }, headers: request.headers })).status === true;
        } catch {
          return false;
        }
      },
      deleteAccount: async (accountId) => new People({ app, auth: await getAuthDatabase(), connections: await connectionService() }).deleteOwnAccount(accountId),
      endingCookies: async (request) => {
        const auth = await getAuth();
        if (!auth) return [];
        const response = await auth.api.signOut({ headers: request.headers, asResponse: true });
        return response.headers.getSetCookie();
      },
    },
  };
}
