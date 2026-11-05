import { sql } from "drizzle-orm";
import { SOVEREIGN_PROVIDER_ID } from "../auth/config";
import { authConfig, getAuth, getSession, listAccounts, localAuthConfig } from "../auth/server";
import { getAuthDatabase, getDatabase } from "../db/boot";
import { dbGet } from "../db/exec";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import { connectionService } from "../connections/server";
import { RateLimiter } from "../limits/rate";
import { People } from "../sovereign/people";
import type { AccountDeps, Caller } from "./http";

const authTables = (database: { dialect: string }) => (database.dialect === "postgres" ? postgresAuth : sqliteAuth);

/** Who is calling, and what `http.ts` needs. Null when no way of signing in is on: there are no accounts to speak of. */
export async function accountContext(): Promise<{ caller: Caller | null; deps: AccountDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  const app = await getDatabase();
  const authDatabase = await getAuthDatabase();
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
      sovereignLinked: async () => (await listAccounts()).some((account) => account.providerId === SOVEREIGN_PROVIDER_ID),
      changeEmail: async (accountId, next, request) => {
        const auth = await getAuth();
        if (!auth) return { result: "taken", cookies: [] };
        const response = await auth.api.changeEmail({ body: { newEmail: next, callbackURL: "/account" }, headers: request.headers, asResponse: true });
        if (!response.ok) throw new Error(`change-email answered ${response.status}`);
        const cookies = response.headers.getSetCookie();
        const { user } = authTables(authDatabase);
        const now = await dbGet<{ email: string }>(authDatabase, sql`SELECT email FROM ${user} WHERE id = ${accountId}`);
        if (now?.email === next) return { result: "changed", cookies };
        return { result: authConfig().enabled && localAuthConfig()?.smtp !== undefined ? "asked" : "taken", cookies };
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
