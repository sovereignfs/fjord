import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Database } from "../db/client";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import type { Mailer } from "../mail/mailer";
import { passwordResetEmail, verificationEmail } from "../mail/templates";
import type { EnabledAuthConfig } from "./config";
import { countUsers } from "./users";

/**
 * Sign-in (DESIGN.md §6) on better-auth, stored in the auth store through its Drizzle adapter:
 * local, which is email and password, passkeys and two-factor, and/or Sovereign, which is OIDC.
 * A way that is not configured is not mounted at all, so it answers 404 and not "disabled".
 * Built from a configuration, a database and a mailer, and nothing global, so a test can make
 * one against any of the three databases and read the mail it sends.
 */
export interface AuthDependencies {
  config: EnabledAuthConfig;
  /** The auth store's database. */
  database: Database;
  /** Present when SMTP is configured; without it there is no verification email and no reset. */
  mailer?: Mailer;
}

/** The id Sovereign sign-in is known by: it is in the callback URL registered with Sovereign. */
export const SOVEREIGN_PROVIDER_ID = "sovereign";

/** The code a refused sign-up carries, in the API's answer and in the `?error=` of a redirect. */
export const SIGNUP_CLOSED = "SIGNUP_CLOSED";

/** The label better-auth reports sessions under, and the cookie prefix, so ours do not collide with another app's on localhost. */
const COOKIE_PREFIX = "fjord";

export function createAuth({ config, database, mailer }: AuthDependencies) {
  const schema = database.dialect === "postgres" ? postgresAuth : sqliteAuth;
  const { local, sovereign } = config;

  return betterAuth({
    appName: config.name,
    secret: config.secret,
    baseURL: config.url,
    trustedOrigins: [config.url],
    database: drizzleAdapter(database.db, {
      provider: database.dialect === "postgres" ? "pg" : "sqlite",
      schema,
    }),
    emailAndPassword: local
      ? {
          enabled: true,
          minPasswordLength: local.passwordMinLength,
          requireEmailVerification: local.requireEmailVerification,
          // With verification required there is no session until the address is confirmed.
          autoSignIn: !local.requireEmailVerification,
          // Whoever knew the old password may be signed in somewhere: resetting it ends those sessions.
          revokeSessionsOnPasswordReset: true,
          ...(mailer
            ? {
                sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
                  await mailer.send(passwordResetEmail(user.email, config.name, url));
                },
              }
            : {}),
        }
      : { enabled: false },
    emailVerification: local
      ? {
          sendOnSignUp: local.requireEmailVerification,
          // Following the link in the email signs the person in, instead of asking them to
          // go back and do it.
          autoSignInAfterVerification: true,
          ...(mailer
            ? {
                sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
                  await mailer.send(verificationEmail(user.email, config.name, url));
                },
              }
            : {}),
        }
      : {},
    account: {
      // A Sovereign login is matched to an account by its `sub`, never by an email address that
      // happens to be the same as a local account's (DESIGN.md §6). Linking the two is done
      // from a signed-in session (ROADMAP 1a.4), and until then such a login is refused.
      accountLinking: { disableImplicitLinking: true },
      // The tokens Sovereign hands over are not used after sign-in; what is kept is kept encrypted.
      encryptOAuthTokens: true,
    },
    // Counted in the database, not in memory, so a limit holds across every process.
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: config.url.startsWith("https:"),
      // better-auth skips its origin check when NODE_ENV is "test", which would let a test pass
      // on behaviour production does not have. Say so, so the two are the same.
      disableOriginCheck: false,
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (config.signUp === "open") return;
            if ((await countUsers(database)) > 0) {
              // With a code, so that a refused Sovereign login is sent back to the sign-in page with
              // the reason; without one, better-auth answers the callback with bare JSON.
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this instance.", code: SIGNUP_CLOSED });
            }
          },
        },
      },
    },
    plugins: [
      ...(local
        ? [
            twoFactor({
              issuer: config.name,
              backupCodeOptions: { amount: 10 },
              // A six-digit code has a million possibilities, and a fresh sign-in (which needs the
              // password) gives five new guesses, so the cap has to be on the account and not only
              // on one attempt or one address. It is better-auth's default; written out so a change
              // to the default cannot quietly weaken it.
              accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
            }),
            passkey({ rpID: local.passkeyRpId, rpName: config.name, origin: config.url }),
          ]
        : []),
      ...(sovereign
        ? [
            genericOAuth({
              config: [
                {
                  providerId: SOVEREIGN_PROVIDER_ID,
                  name: "Sovereign",
                  discoveryUrl: `${sovereign.issuer}/.well-known/openid-configuration`,
                  // The profile comes from the ID token, so refuse to run on one that cannot be
                  // checked against the issuer's keys: a discovery document without them is not
                  // a reason to trust whatever the token endpoint says.
                  requireIdTokenVerification: true,
                  clientId: sovereign.clientId,
                  clientSecret: sovereign.clientSecret,
                  authentication: "basic",
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  // Signing out of Fjord does not sign the person out of Sovereign, which is
                  // their account for other things as well.
                  disableProviderLogout: true,
                  mapProfileToUser: (profile) => ({
                    // Sovereign's contract is `sub`, `email` and `name`; a missing name is not a reason to refuse.
                    name: typeof profile.name === "string" && profile.name.trim() !== "" ? profile.name : String(profile.email ?? "").split("@")[0] || "Sovereign user",
                    emailVerified: profile.emailVerified === true,
                  }),
                },
              ],
            }),
          ]
        : []),
      // Must be last: it turns cookies set while handling a Server Action into real ones.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
