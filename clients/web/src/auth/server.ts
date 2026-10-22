import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAuthDatabase } from "../db/boot";
import { createSmtpMailer } from "../mail/mailer";
import { type Auth, createAuth } from "./auth";
import { type AuthConfig, type LocalAuthConfig, resolveAuthConfig } from "./config";
import { countUsers } from "./users";

/**
 * The server's view of sign-in: the configuration, the better-auth instance, and the session
 * of whoever is asking. Used by pages and routes, never by a test (which makes its own with
 * `createAuth`). Local sign-in is off unless FJORD_AUTH_LOCAL is set, and then `getAuth()` is
 * null and everything that needs it answers 404: there is no local sign-in, not a disabled one.
 */
const KEY = Symbol.for("fjord.auth");
type Holder = { [KEY]?: { config: AuthConfig; auth?: Promise<Auth> } };

function holder(): NonNullable<Holder[typeof KEY]> {
  const store = globalThis as Holder;
  // Resolved once, so a bad setting is reported at start-up and not on someone's first sign-in.
  store[KEY] ??= { config: resolveAuthConfig(process.env) };
  return store[KEY];
}

export function authConfig(): AuthConfig {
  return holder().config;
}

/** The local sign-in settings, or undefined when it is off. */
export function localAuthConfig(): LocalAuthConfig | undefined {
  const config = authConfig();
  return config.local ? config : undefined;
}

export function getAuth(): Promise<Auth | null> {
  const state = holder();
  const config = state.config;
  if (!config.local) return Promise.resolve(null);
  state.auth ??= getAuthDatabase().then((database) =>
    createAuth({ config, database, ...(config.smtp ? { mailer: createSmtpMailer(config.smtp) } : {}) }),
  );
  return state.auth;
}

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/** The signed-in person's session, or null: nobody signed in, or local sign-in is off. */
export async function getSession(): Promise<Session | null> {
  const auth = await getAuth();
  if (!auth) return null;
  return auth.api.getSession({ headers: await headers() });
}

/** For a page that is only for someone signed in. */
export async function requireSession(): Promise<Session> {
  if (!authConfig().local) notFound();
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

/**
 * Whether a new account can be made: yes if sign-up is open, yes for the very first account
 * whatever the setting (someone has to be first), and otherwise no.
 */
export async function signUpAvailable(): Promise<boolean> {
  const config = localAuthConfig();
  if (!config) return false;
  if (config.signUp === "open") return true;
  const auth = await getAuth();
  if (!auth) return false;
  return (await countUsers(await getAuthDatabase())) === 0;
}
