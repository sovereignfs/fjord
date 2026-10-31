import { createSign } from "node:crypto";
import { ProviderError } from "../providers/errors";
import type { GitHubAppConfig } from "./config";

/**
 * Short-lived tokens for an installation of the App (DESIGN.md §7, ROADMAP 1a.6). The App proves itself to GitHub with a JWT
 * signed by its private key (valid for minutes), and is given a token for one installation (valid for an hour). Nothing is stored:
 * a token is kept in memory until shortly before it expires and is asked for again, so a leaked database holds no way into a
 * repository. Neither the key nor a token is ever logged or put in an error.
 */
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** The App's own JWT: issued a minute ago (for clocks that differ) and good for nine minutes, GitHub's limit being ten. */
export function appJwt(config: Pick<GitHubAppConfig, "appId" | "privateKey">, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: config.appId }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(config.privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

export interface InstallationTokensOptions {
  config: Pick<GitHubAppConfig, "appId" | "privateKey">;
  apiUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class InstallationTokens {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly kept = new Map<number, { token: string; expiresAt: number }>();
  private readonly asking = new Map<number, Promise<string>>();

  constructor(private readonly options: InstallationTokensOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A token for the installation that is good for at least a few more minutes. */
  async token(installationId: number): Promise<string> {
    const held = this.kept.get(installationId);
    if (held && held.expiresAt - this.now() > RENEW_BEFORE_MS) return held.token;
    // Several requests at once make one request to GitHub.
    let pending = this.asking.get(installationId);
    if (!pending) {
      pending = this.ask(installationId).finally(() => this.asking.delete(installationId));
      this.asking.set(installationId, pending);
    }
    return pending;
  }

  private async ask(installationId: number): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${appJwt(this.options.config, this.now())}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "fjord-web",
        },
      });
    } catch {
      throw new ProviderError("unavailable", "GitHub could not be reached to renew an installation token");
    }
    if (response.status === 401) throw new ProviderError("unauthorized", "GitHub did not accept the App's key", { status: 401 });
    // The installation was removed, or the App was uninstalled from the account.
    if (response.status === 404) throw new ProviderError("unauthorized", "the App is no longer installed", { status: 404 });
    if (response.status === 403) throw new ProviderError("forbidden", "the installation is suspended", { status: 403 });
    if (response.status === 429) throw new ProviderError("rate_limited", "GitHub is limiting the App", { status: 429 });
    if (!response.ok) throw new ProviderError("unavailable", `GitHub answered ${response.status} to a token request`, { status: response.status });
    const body = (await response.json().catch(() => undefined)) as { token?: unknown; expires_at?: unknown } | undefined;
    const expiresAt = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (typeof body?.token !== "string" || body.token === "" || !Number.isFinite(expiresAt)) throw new ProviderError("unavailable", "GitHub's answer to a token request was not understood");
    this.kept.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }
}
