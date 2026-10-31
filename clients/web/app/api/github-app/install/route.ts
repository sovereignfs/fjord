import { authConfig, getSession } from "../../../../src/auth/server";
import { gitHubApp } from "../../../../src/github-app/server";
import { handleInstall } from "../../../../src/github-app/http";
import { completeFor } from "../../../../src/github-app/complete";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = authConfig();
  if (!config.enabled) return new Response(null, { status: 404 });
  const session = await getSession();
  const app = gitHubApp();
  return handleInstall(request, session ? { accountId: session.user.id } : null, { config: app?.config, webUrl: app?.webUrl ?? "", origin: config.url, complete: completeFor });
}
