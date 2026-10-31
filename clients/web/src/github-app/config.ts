import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { ConfigError, type Env } from "../db/config";
import { type ReadFile, resolveSecret } from "../secret-env";
import { GITHUB_API_URL } from "../connections/config";

/**
 * The GitHub App this instance registered (DESIGN.md §7, ROADMAP 1a.6). Each instance has its own App, so nothing of it is in the
 * code: its settings are these variables, all or none.
 *
 *   FJORD_GITHUB_APP_ID              the App's id (a number)
 *   FJORD_GITHUB_APP_SLUG            its name in the address `github.com/apps/<slug>`, where people install it
 *   FJORD_GITHUB_APP_PRIVATE_KEY     the private key (PEM) it signs the short-lived tokens' requests with; or ..._FILE
 *   FJORD_GITHUB_APP_CLIENT_ID       the App's client id, and
 *   FJORD_GITHUB_APP_CLIENT_SECRET   its secret (or ..._FILE): used once, when someone installs, to learn which repositories
 *                                    *they* can reach, so that nobody connects an installation that is not theirs
 *   FJORD_GITHUB_APP_WEBHOOK_SECRET  signs the webhooks GitHub sends (16 characters or more); or ..._FILE
 *
 * Some set and some not is an error that names what is missing: a half-configured App would fail on the first person to use it.
 */
export interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

const NAMES = ["FJORD_GITHUB_APP_ID", "FJORD_GITHUB_APP_SLUG", "FJORD_GITHUB_APP_PRIVATE_KEY", "FJORD_GITHUB_APP_CLIENT_ID", "FJORD_GITHUB_APP_CLIENT_SECRET", "FJORD_GITHUB_APP_WEBHOOK_SECRET"] as const;
const MIN_WEBHOOK_SECRET = 16;

export function githubAppConfig(env: Env = process.env, readFile: ReadFile = (path) => readFileSync(path, "utf8")): GitHubAppConfig | undefined {
  const values = Object.fromEntries(NAMES.map((name) => [name, resolveSecret(name, env, readFile)?.trim()])) as Record<(typeof NAMES)[number], string | undefined>;
  const missing = NAMES.filter((name) => !values[name]);
  if (missing.length === NAMES.length) return undefined;
  if (missing.length > 0) throw new ConfigError(`The GitHub App is half set up: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of its variables, or none.`);

  const appId = values.FJORD_GITHUB_APP_ID as string;
  const slug = values.FJORD_GITHUB_APP_SLUG as string;
  if (!/^[1-9][0-9]{0,15}$/.test(appId)) throw new ConfigError("FJORD_GITHUB_APP_ID must be the App's number.");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(slug)) throw new ConfigError("FJORD_GITHUB_APP_SLUG must be the App's name as it is in github.com/apps/<name>.");
  // A key in an environment variable often has its line breaks written as \n.
  const privateKey = (values.FJORD_GITHUB_APP_PRIVATE_KEY as string).replace(/\\n/g, "\n");
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa") throw new Error("not rsa");
  } catch {
    throw new ConfigError("FJORD_GITHUB_APP_PRIVATE_KEY is not an RSA private key in PEM form (the .pem file GitHub gave when the App's key was made).");
  }
  const webhookSecret = values.FJORD_GITHUB_APP_WEBHOOK_SECRET as string;
  if (webhookSecret.length < MIN_WEBHOOK_SECRET) throw new ConfigError(`FJORD_GITHUB_APP_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET} characters.`);

  return { appId, slug, privateKey, clientId: values.FJORD_GITHUB_APP_CLIENT_ID as string, clientSecret: values.FJORD_GITHUB_APP_CLIENT_SECRET as string, webhookSecret };
}

/**
 * Where people sign in to GitHub and install the App: github.com, or an Enterprise Server's own address (its API is at `/api/v3` of it).
 * Derived from the API address, so that the two cannot point at different hosts.
 */
export function githubWebUrl(apiUrl: string): string {
  if (apiUrl === GITHUB_API_URL) return "https://github.com";
  return new URL(apiUrl).origin;
}
