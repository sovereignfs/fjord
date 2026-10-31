import { connectionService } from "../connections/server";
import { completeInstall, type InstallOutcome } from "./install";
import { gitHubApp, installationProvider } from "./server";

/** Connect what an installation reaches for the account, with the instance's App and connection service. */
export async function completeFor(accountId: string, input: { code: string; installationId: number }): Promise<InstallOutcome> {
  const app = gitHubApp();
  if (!app) return { ok: false, reason: "not_configured" };
  return completeInstall({ config: app.config, apiUrl: app.apiUrl, webUrl: app.webUrl, service: await connectionService(), installation: installationProvider }, accountId, input);
}
