import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAuthDatabase } from "../db/boot";
import { createSmtpMailer } from "../mail/mailer";
import { type Auth, createAuth } from "./auth";
import { type AuthConfig, type LocalAuthConfig, type SovereignSettings, resolveAuthConfig } from "./config";
import { countUsers } from "./users";

/**
 * The server's view of sign-in: the configuration, the better-auth instance, and the session
 * of whoever is asking. Used by pages and routes, never by a test (which makes its own with
 * `createAuth`). Each way of signing in is off unless it is configured, and with neither on
 * `getAuth()` is null and everything that needs it answers 404: there is no sign-in, not a
 * disabled one.
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

/** The local sign-in settings (with the instance's own), or undefined when it is off. */
export function localAuthConfig(): LocalAuthConfig | undefined {
  const config = authConfig();
  if (!config.enabled || !config.local) return undefined;
  const { enabled: _enabled, local, sovereign: _sovereign, ...instance } = config;
  return { ...instance, ...local };
}

/** The Sovereign sign-in settings, or undefined when it is off. */
export function sovereignAuthConfig(): SovereignSettings | undefined {
  const config = authConfig();
  return config.enabled ? config.sovereign : undefined;
}

export function getAuth(): Promise<Auth | null> {
  const state = holder();
  const config = state.config;
  if (!config.enabled) return Promise.resolve(null);
  const smtp = config.local?.smtp;
  state.auth ??= getAuthDatabase().then((database) =>
    createAuth({ config, database, ...(smtp ? { mailer: createSmtpMailer(smtp) } : {}) }),
  );
  return state.auth;
}

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

/** A way of signing in that an account has: better-auth keeps one `account` per way. Nothing secret. */
export interface LinkedAccount {
  /** better-auth's id for the row: what unlinking names. */
  id: string;
  /** `credential` for a password, or the provider's id (`sovereign`). */
  providerId: string;
}

/** The signed-in person's accounts: a password, and/or a linked Sovereign. Empty when nobody is signed in. */
export async function listAccounts(): Promise<LinkedAccount[]> {
  const auth = await getAuth();
  if (!auth) return [];
  const accounts = await auth.api.listUserAccounts({ headers: await headers() });
  return accounts.map((account) => ({ id: account.id, providerId: account.providerId }));
}

/** The signed-in person's session, or null: nobody signed in, or sign-in is off. */
export async function getSession(): Promise<Session | null> {
  const auth = await getAuth();
  if (!auth) return null;
  return auth.api.getSession({ headers: await headers() });
}

/** For a page that is only for someone signed in. */
export async function requireSession(): Promise<Session> {
  if (!authConfig().enabled) notFound();
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
