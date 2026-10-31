import { randomBytes } from "node:crypto";
import { isConnectionError } from "../connections/errors";
import type { ConnectionService, InstallationResult } from "../connections/service";
import { GitHubClient } from "../providers/github/http";
import { isProviderError } from "../providers/errors";
import type { Provider, RepositoryRef } from "../providers/types";
import type { GitHubAppConfig } from "./config";

/**
 * Installing the App, from the instance's side (DESIGN.md §7, ROADMAP 1a.6). A person is sent to GitHub, where they install the App
 * and **pick the repositories** it may reach; GitHub sends them back with a `code` and the installation's id.
 *
 * The id alone proves nothing: anyone can write any number into an address. So the App is set to ask the person to authorise it as
 * they install, and the `code` is traded here for a token that is **theirs**, used once to ask GitHub which repositories of that
 * installation *they* can reach. Only those are connected. That is what keeps one account from connecting an installation it does not
 * belong to, and a member of an organisation from reaching through the App what GitHub would not let them reach themselves. The
 * person's token is never stored; the connection keeps only which installation it is, and tokens are asked for when they are needed.
 *
 * And the way back must be one this browser started: `state` is a random value set in a cookie when they left and compared when they
 * return, so a link someone else made cannot connect repositories to a signed-in person.
 */
export const STATE_COOKIE = "fjord_github_app";
/** How long a person has between leaving for GitHub and coming back. */
export const STATE_MAX_AGE_SECONDS = 15 * 60;
/** The most repositories connected from one installation at once. */
export const MAX_REPOSITORIES = 100;

export const newState = (): string => randomBytes(24).toString("base64url");

export function installUrl(config: Pick<GitHubAppConfig, "slug">, webUrl: string, state: string): string {
  return `${webUrl}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export type InstallFailure = "code_rejected" | "not_yours" | "nothing_to_connect" | "rate_limited" | "unavailable" | "not_configured";

export type InstallOutcome =
  | { ok: true; added: number; already: number; skipped: number }
  | { ok: false; reason: InstallFailure };

export interface InstallDeps {
  config: GitHubAppConfig;
  apiUrl: string;
  webUrl: string;
  fetch?: typeof fetch;
  service: Pick<ConnectionService, "addFromInstallation">;
  /** The provider that acts as the installation. */
  installation: (installationId: number) => Provider;
}

/** The person's token for the App, in exchange for the `code` GitHub sent them back with. Used once, kept nowhere. */
async function userToken(deps: InstallDeps, code: string): Promise<string | undefined> {
  const fetchImpl = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${deps.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "fjord-web" },
      body: JSON.stringify({ client_id: deps.config.clientId, client_secret: deps.config.clientSecret, code }),
    });
  } catch {
    throw new InstallError("unavailable");
  }
  if (response.status >= 500) throw new InstallError("unavailable");
  const body = (await response.json().catch(() => undefined)) as { access_token?: unknown } | undefined;
  // A wrong, used or expired code is a 200 with an `error`, as GitHub answers it.
  return typeof body?.access_token === "string" && body.access_token !== "" ? body.access_token : undefined;
}

class InstallError extends Error {
  constructor(readonly reason: InstallFailure) {
    super(reason);
  }
}

/** The repositories of the installation that this person can reach on GitHub. */
async function reachableBy(deps: InstallDeps, token: string, installationId: number): Promise<RepositoryRef[]> {
  const client = new GitHubClient({ apiUrl: deps.apiUrl, token: async () => token, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  try {
    const repos = await client.paginate<{ name: string; owner: { login: string } }>(`/user/installations/${installationId}/repositories`, (page) => (page as { repositories: { name: string; owner: { login: string } }[] }).repositories);
    return repos.map((repo) => ({ owner: repo.owner.login, name: repo.name }));
  } catch (error) {
    // An installation that is not theirs is not found, or forbidden, to them.
    if (isProviderError(error, "not_found") || isProviderError(error, "forbidden")) throw new InstallError("not_yours");
    if (isProviderError(error, "unauthorized")) throw new InstallError("code_rejected");
    if (isProviderError(error, "rate_limited")) throw new InstallError("rate_limited");
    throw new InstallError("unavailable");
  }
}

export async function completeInstall(deps: InstallDeps, accountId: string, input: { code: string; installationId: number }): Promise<InstallOutcome> {
  try {
    const token = await userToken(deps, input.code);
    if (!token) return { ok: false, reason: "code_rejected" };
    const reachable = await reachableBy(deps, token, input.installationId);
    if (reachable.length === 0) return { ok: false, reason: "nothing_to_connect" };

    let result: InstallationResult;
    try {
      result = await deps.service.addFromInstallation(accountId, input.installationId, deps.installation(input.installationId), reachable.slice(0, MAX_REPOSITORIES));
    } catch (error) {
      if (isConnectionError(error, "rate_limited")) throw new InstallError("rate_limited");
      if (isConnectionError(error, "not_configured")) throw new InstallError("not_configured");
      throw new InstallError("unavailable");
    }
    return { ok: true, added: result.added.length, already: result.already.length, skipped: result.skipped.length };
  } catch (error) {
    if (error instanceof InstallError) return { ok: false, reason: error.reason };
    throw error;
  }
}
