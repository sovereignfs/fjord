import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { Database } from "../db/client";
import * as postgresAuth from "../db/schema/postgres/auth";
import * as sqliteAuth from "../db/schema/sqlite/auth";
import type { Mailer } from "../mail/mailer";
import { passwordResetEmail, verificationEmail } from "../mail/templates";
import type { LocalAuthConfig } from "./config";
import { countUsers } from "./users";

/**
 * Local sign-in (DESIGN.md §6): email and password, passkeys and two-factor, on better-auth,
 * stored in the auth store through its Drizzle adapter. Built from a configuration, a database
 * and a mailer, and nothing global, so a test can make one against any of the three databases
 * and read the mail it sends.
 */
export interface AuthDependencies {
  config: LocalAuthConfig;
  /** The auth store's database. */
  database: Database;
  /** Present when SMTP is configured; without it there is no verification email and no reset. */
  mailer?: Mailer;
}

/** The label better-auth reports sessions under, and the cookie prefix, so ours do not collide with another app's on localhost. */
const COOKIE_PREFIX = "fjord";

export function createAuth({ config, database, mailer }: AuthDependencies) {
  const schema = database.dialect === "postgres" ? postgresAuth : sqliteAuth;

  return betterAuth({
    appName: config.name,
    secret: config.secret,
    baseURL: config.url,
    trustedOrigins: [config.url],
    database: drizzleAdapter(database.db, {
      provider: database.dialect === "postgres" ? "pg" : "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: config.passwordMinLength,
      requireEmailVerification: config.requireEmailVerification,
      // With verification required there is no session until the address is confirmed.
      autoSignIn: !config.requireEmailVerification,
      // Whoever knew the old password may be signed in somewhere: resetting it ends those sessions.
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              await mailer.send(passwordResetEmail(user.email, config.name, url));
            },
          }
        : {}),
    },
    emailVerification: {
      sendOnSignUp: config.requireEmailVerification,
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
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this instance." });
            }
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: config.name,
        backupCodeOptions: { amount: 10 },
        // A six-digit code has a million possibilities, and a fresh sign-in (which needs the
        // password) gives five new guesses, so the cap has to be on the account and not only
        // on one attempt or one address. It is better-auth's default; written out so a change
        // to the default cannot quietly weaken it.
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 15 * 60 },
      }),
      passkey({ rpID: config.passkeyRpId, rpName: config.name, origin: config.url }),
      // Must be last: it turns cookies set while handling a Server Action into real ones.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
