import { resolveGitHubApiUrl } from "../connections/config";
import { GitHubProvider } from "../providers/github/provider";
import { type GitHubAppConfig, githubAppConfig, githubWebUrl } from "./config";
import { InstallationTokens } from "./tokens";

/**
 * The instance's GitHub App, for the server: its settings from the environment (undefined when it has none), and the one set of
 * installation tokens the process keeps, so that a token asked for once is used by every request until it is nearly spent.
 * Never for a test, which builds its own.
 */
let tokens: { config: GitHubAppConfig; apiUrl: string; tokens: InstallationTokens } | undefined;

export function gitHubApp(): { config: GitHubAppConfig; apiUrl: string; webUrl: string; tokens: InstallationTokens } | undefined {
  const config = githubAppConfig();
  if (!config) return undefined;
  const apiUrl = resolveGitHubApiUrl(process.env);
  if (!tokens || tokens.config.appId !== config.appId || tokens.config.privateKey !== config.privateKey || tokens.apiUrl !== apiUrl) {
    tokens = { config, apiUrl, tokens: new InstallationTokens({ config, apiUrl }) };
  }
  return { config, apiUrl, webUrl: githubWebUrl(apiUrl), tokens: tokens.tokens };
}

/** A provider that acts as one installation of the App. */
export function installationProvider(installationId: number): GitHubProvider {
  const app = gitHubApp();
  if (!app) throw new Error("this instance has no GitHub App");
  return new GitHubProvider({ apiUrl: app.apiUrl, token: () => app.tokens.token(installationId), scope: "installation" });
}
