import { readFileSync } from "node:fs";
import { ConfigError, type Env } from "../db/config";

/**
 * How people sign in, read from the environment in one place (DESIGN.md §6). Nothing else
 * reads these variables.
 *
 *   FJORD_AUTH_LOCAL                 1 or true turns on email and password, passkeys and
 *                                    two-factor. Unset, there is no local sign-in at all.
 *   FJORD_URL                        the address people use, e.g. https://fjord.example.com.
 *                                    Links in email and the passkey origin are built from it.
 *   FJORD_AUTH_SECRET[_FILE]         at least 32 characters, to sign sessions and tokens.
 *   FJORD_AUTH_SIGNUP                closed (default): only the first account can be made, and
 *                                    later sign-ups are refused. open: anyone can sign up.
 *   FJORD_AUTH_PASSWORD_MIN_LENGTH   default 10.
 *   FJORD_NAME                       what an authenticator app and a passkey call this
 *                                    instance. Default Fjord.
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

export type AuthConfig = { local: false } | LocalAuthConfig;

export interface LocalAuthConfig {
  local: true;
  /** The instance's origin, no trailing slash. */
  url: string;
  secret: string;
  signUp: "open" | "closed";
  passwordMinLength: number;
  name: string;
  passkeyRpId: string;
  requireEmailVerification: boolean;
  smtp?: SmtpConfig;
}

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
  if (!isOn(env.FJORD_AUTH_LOCAL)) return { local: false };

  const url = resolveUrl(env.FJORD_URL);
  const secret = resolveSecret("FJORD_AUTH_SECRET", env, readSecretFile);
  if (secret === undefined) throw new ConfigError("FJORD_AUTH_LOCAL is on, so FJORD_AUTH_SECRET (or FJORD_AUTH_SECRET_FILE) is required.");
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`FJORD_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters (openssl rand -base64 32 makes one).`);
  }

  const signUp = (env.FJORD_AUTH_SIGNUP ?? "").trim().toLowerCase() || "closed";
  if (signUp !== "open" && signUp !== "closed") throw new ConfigError(`FJORD_AUTH_SIGNUP must be "open" or "closed" (got "${signUp}").`);

  const smtp = resolveSmtp(env, readSecretFile);
  const requireEmailVerification = resolveVerification(env.FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION, smtp !== undefined);

  return {
    local: true,
    url,
    secret,
    signUp,
    passwordMinLength: positiveInt(env.FJORD_AUTH_PASSWORD_MIN_LENGTH) ?? DEFAULT_PASSWORD_MIN_LENGTH,
    name: (env.FJORD_NAME ?? "").trim() || "Fjord",
    passkeyRpId: (env.FJORD_PASSKEY_RP_ID ?? "").trim() || new URL(url).hostname,
    requireEmailVerification,
    ...(smtp ? { smtp } : {}),
  };
}

function isOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

function resolveUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") throw new ConfigError("FJORD_AUTH_LOCAL is on, so FJORD_URL (the address people use) is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("FJORD_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("FJORD_URL must be an http(s) URL.");
  // A passkey and a session cookie need a secure origin, and a password must not cross the
  // network in the clear. localhost is the one exception, for development.
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol === "http:" && !local) throw new ConfigError("FJORD_URL must be https, except on localhost.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new ConfigError("FJORD_URL must be an origin, with no path.");
  return url.origin;
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
  if (!config.local) return "local sign-in is off";
  const mail = config.smtp ? `email via ${config.smtp.host}:${config.smtp.port}` : "no email";
  const verify = config.requireEmailVerification ? ", address verification required" : "";
  return `local sign-in on at ${config.url}, sign-up ${config.signUp}, ${mail}${verify}`;
}
