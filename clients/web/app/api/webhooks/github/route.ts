import { connectionService } from "../../../../src/connections/server";
import { gitHubApp } from "../../../../src/github-app/server";
import { handleGitHubWebhook } from "../../../../src/github-app/webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleGitHubWebhook(request, { secret: gitHubApp()?.config.webhookSecret, pushed: async (ref, branch) => (await connectionService()).pushed(ref, branch) });
}
