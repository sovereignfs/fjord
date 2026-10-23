import { readFileSync } from "node:fs";
import { ConfigError, type Env } from "../db/config";

/**
 * How people sign in, read from the environment in one place (DESIGN.md §6). Nothing else
 * reads these variables.
 *
 * Two ways to sign in, each off unless it is set, and either or both can be on. With neither,
 * there is no sign-in at all and the settings below are not read.
 *
 *   FJORD_AUTH_LOCAL                 1 or true turns on email and password, passkeys and
 *                                    two-factor.
 *   FJORD_AUTH_SOVEREIGN_ISSUER      a Sovereign instance's OIDC issuer, e.g.
 *                                    https://auth.sovereign.example.com/api/auth
 *   FJORD_AUTH_SOVEREIGN_CLIENT_ID   the client registered for this instance in that Sovereign's
 *                                    Console (External clients), with the redirect URI
 *                                    <FJORD_URL>/api/auth/callback/sovereign
 *   FJORD_AUTH_SOVEREIGN_CLIENT_SECRET[_FILE]
 *                                    its secret. All three are needed together.
 *
 * With either on:
 *
 *   FJORD_URL                        the address people use, e.g. https://fjord.example.com.
 *                                    Links in email, the passkey origin and the OIDC redirect
 *                                    URI are built from it.
 *   FJORD_AUTH_SECRET[_FILE]         at least 32 characters, to sign sessions and tokens.
 *   FJORD_AUTH_SIGNUP                closed (default): only the first account can be made, and
 *                                    later sign-ups are refused, by either method. open: anyone
 *                                    can sign up (with Sovereign: anyone it signs in).
 *
 * With local sign-in on:
 *
 *   FJORD_AUTH_PASSWORD_MIN_LENGTH   default 10.
 *   FJORD_NAME                       what an authenticator app and a passkey call this
 *                                    instance (and the sign-in page). Default Fjord.
 *   FJORD_PASSKEY_RP_ID              the passkey relying party id; default, the host of
 *                                    FJORD_URL. Set it to a parent domain to share passkeys
 *                                    across subdomains.
 *
 * Email is optional. With SMTP_HOST set, an address must be verified before first sign-in
 * and a forgotten password can be reset by email; without it, neither: sign-up is immediate
 * and there is no reset by email.
 *
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465), SMTP_USER,
 *   SMTP_PASSWORD[_FILE], SMTP_FROM (required with SMTP_HOST)
 *   FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION   default: true when SMTP is set, else false
 *
 * Secrets can come from a file (`*_FILE`), as container secrets do, so they need not sit in
 * the environment, where `ps` and a crash report can show them.
 */

export type AuthConfig = { enabled: false } | EnabledAuthConfig;

/** What both ways of signing in share. */
export interface InstanceSettings {
  /** The instance's origin, no trailing slash. */
  url: string;
  secret: string;
  signUp: "open" | "closed";
  name: string;
}

export interface LocalSettings {
  passwordMinLength: number;
  passkeyRpId: string;
  requireEmailVerification: boolean;
  smtp?: SmtpConfig;
}

export interface SovereignSettings {
  /** The issuer, no trailing slash; its discovery document is at `/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface EnabledAuthConfig extends InstanceSettings {
  enabled: true;
  local?: LocalSettings;
  sovereign?: SovereignSettings;
}

/** The settings of local sign-in with the instance's own, flattened, for the pages that use it. */
export type LocalAuthConfig = InstanceSettings & LocalSettings;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_PASSWORD_MIN_LENGTH = 10;

type ReadFile = (path: string) => string;

export function resolveAuthConfig(env: Env = process.env, readSecretFile: ReadFile = (path) => readFileSync(path, "utf8")): AuthConfig {
  const local = isOn(env.FJORD_AUTH_LOCAL);
  const sovereign = resolveSovereign(env, readSecretFile);
  if (!local && !sovereign) return { enabled: false };

  const why = local ? "FJORD_AUTH_LOCAL is on" : "Sovereign sign-in is set";
  const url = resolveUrl(env.FJORD_URL, why);
  const secret = resolveSecret("FJORD_AUTH_SECRET", env, readSecretFile);
  if (secret === undefined) throw new ConfigError(`${why}, so FJORD_AUTH_SECRET (or FJORD_AUTH_SECRET_FILE) is required.`);
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`FJORD_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32 makes one).`);
  }

  const signUp = (env.FJORD_AUTH_SIGNUP ?? "").trim().toLowerCase() || "closed";
  if (signUp !== "open" && signUp !== "closed") throw new ConfigError(`FJORD_AUTH_SIGNUP must be "open" or "closed" (got "${signUp}").`);

  return {
    enabled: true,
    url,
    secret,
    signUp,
    name: (env.FJORD_NAME ?? "").trim() || "Fjord",
    ...(local ? { local: resolveLocal(env, url, readSecretFile) } : {}),
    ...(sovereign ? { sovereign } : {}),
  };
}

function resolveLocal(env: Env, url: string, readSecretFile: ReadFile): LocalSettings {
  const smtp = resolveSmtp(env, readSecretFile);
  return {
    passwordMinLength: positiveInt(env.FJORD_AUTH_PASSWORD_MIN_LENGTH) ?? DEFAULT_PASSWORD_MIN_LENGTH,
    passkeyRpId: (env.FJORD_PASSKEY_RP_ID ?? "").trim() || new URL(url).hostname,
    requireEmailVerification: resolveVerification(env.FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION, smtp !== undefined),
    ...(smtp ? { smtp } : {}),
  };
}

/** Off when none of the three is set; an error when only some are, which is never what was meant. */
function resolveSovereign(env: Env, readFile: ReadFile): SovereignSettings | undefined {
  const issuer = (env.FJORD_AUTH_SOVEREIGN_ISSUER ?? "").trim();
  const clientId = (env.FJORD_AUTH_SOVEREIGN_CLIENT_ID ?? "").trim();
  const clientSecret = resolveSecret("FJORD_AUTH_SOVEREIGN_CLIENT_SECRET", env, readFile);
  if (issuer === "" && clientId === "" && clientSecret === undefined) return undefined;

  const missing = [
    issuer === "" ? "FJORD_AUTH_SOVEREIGN_ISSUER" : "",
    clientId === "" ? "FJORD_AUTH_SOVEREIGN_CLIENT_ID" : "",
    clientSecret === undefined ? "FJORD_AUTH_SOVEREIGN_CLIENT_SECRET (or _FILE)" : "",
  ].filter(Boolean);
  if (missing.length > 0) throw new ConfigError(`Sovereign sign-in needs all of its settings; missing ${missing.join(", ")}.`);
  return { issuer: resolveIssuer(issuer), clientId, clientSecret: clientSecret as string };
}

function resolveIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("FJORD_AUTH_SOVEREIGN_ISSUER is not a valid URL.");
  }
  // The client secret goes to this host, and the people who sign in trust what it says about them.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new ConfigError("FJORD_AUTH_SOVEREIGN_ISSUER must be https, except on localhost.");
  }
  if (url.search !== "" || url.hash !== "") throw new ConfigError("FJORD_AUTH_SOVEREIGN_ISSUER must have no query or fragment.");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function resolveUrl(raw: string | undefined, why: string): string {
  const value = (raw ?? "").trim();
  if (value === "") throw new ConfigError(`${why}, so FJORD_URL (the address people use) is required.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("FJORD_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("FJORD_URL must be an http(s) URL.");
  // A passkey and a session cookie need a secure origin, and a password must not cross the
  // network in the clear. localhost is the one exception, for development.
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) throw new ConfigError("FJORD_URL must be https, except on localhost.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new ConfigError("FJORD_URL must be an origin, with no path.");
  return url.origin;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** A value from `NAME`, or from the file `NAME_FILE` names (its trailing newline trimmed). */
function resolveSecret(name: string, env: Env, readFile: ReadFile): string | undefined {
  const direct = env[name];
  const file = (env[`${name}_FILE`] ?? "").trim();
  if (direct && file) throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
  if (file) {
    try {
      return readFile(file).replace(/\r?\n$/, "");
    } catch {
      throw new ConfigError(`${name}_FILE names a file that cannot be read.`);
    }
  }
  return direct === undefined || direct === "" ? undefined : direct;
}

function resolveSmtp(env: Env, readFile: ReadFile): SmtpConfig | undefined {
  const host = (env.SMTP_HOST ?? "").trim();
  if (host === "") return undefined;
  const from = (env.SMTP_FROM ?? "").trim();
  if (from === "") throw new ConfigError("SMTP_HOST is set, so SMTP_FROM (the sender address) is required.");
  const port = positiveInt(env.SMTP_PORT) ?? 587;
  const secure = env.SMTP_SECURE === undefined || env.SMTP_SECURE === "" ? port === 465 : isOn(env.SMTP_SECURE);
  const user = (env.SMTP_USER ?? "").trim();
  const password = resolveSecret("SMTP_PASSWORD", env, readFile);
  return { host, port, secure, from, ...(user ? { user } : {}), ...(password !== undefined ? { password } : {}) };
}

function resolveVerification(raw: string | undefined, smtpSet: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return smtpSet;
  const on = value === "1" || value === "true";
  const off = value === "0" || value === "false";
  if (!on && !off) throw new ConfigError('FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION must be "true" or "false".');
  if (on && !smtpSet) throw new ConfigError("FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION needs SMTP_HOST: nothing could send the link.");
  return on;
}

function positiveInt(raw: string | undefined): number | undefined {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** What is safe to print about the settings: never the secret, a password or a token. */
export function describeAuth(config: AuthConfig): string {
  if (!config.enabled) return "sign-in is off";
  const ways: string[] = [];
  if (config.local) {
    const mail = config.local.smtp ? `email via ${config.local.smtp.host}:${config.local.smtp.port}` : "no email";
    ways.push(`local (${mail}${config.local.requireEmailVerification ? ", address verification required" : ""})`);
  }
  if (config.sovereign) ways.push(`Sovereign (${config.sovereign.issuer})`);
  return `sign-in on at ${config.url} by ${ways.join(" and ")}, sign-up ${config.signUp}`;
}
