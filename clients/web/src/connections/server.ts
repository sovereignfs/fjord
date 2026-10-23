import { credentialStore } from "../crypto/server";
import { getDatabase } from "../db/boot";
import { GitHubProvider } from "../providers/github/provider";
import { resolveGitHubApiUrl } from "./config";
import { ConnectionService } from "./service";

/**
 * The server's connection service, for routes and pages: the app's database, the credential
 * store (which needs `FJORD_ENCRYPTION_KEY` and says so if it is missing) and GitHub with a
 * personal access token. Never for a test, which builds its own.
 */
export async function connectionService(): Promise<ConnectionService> {
  const credentials = await credentialStore();
  const apiUrl = resolveGitHubApiUrl(process.env);
  return new ConnectionService({
    database: await getDatabase(),
    credentials,
    github: (token) => new GitHubProvider({ apiUrl, token: async () => token, scope: "user" }),
  });
}
