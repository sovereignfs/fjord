import { getDatabase } from "../../../../src/db/boot";
import { authConfig } from "../../../../src/auth/server";
import { handleEnter } from "../../../../src/sharing/enter";
import { LinkService } from "../../../../src/sharing/links";

export const dynamic = "force-dynamic";

/** Entering by a share link: a cookie and a redirect to the clean address (ROADMAP 1c.4). `proxy.ts` sends `/doc/<id>?token=` here. */
export async function GET(request: Request): Promise<Response> {
  const config = authConfig();
  if (!config.enabled) return new Response(null, { status: 404 });
  return handleEnter(request, { links: new LinkService(await getDatabase()), secure: config.url.startsWith("https://") });
}
