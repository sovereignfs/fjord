import { authConfig } from "../../../../src/auth/server";
import { handleGuestDraft } from "../../../../src/sharing/guest-http";
import { saveGuestDraftFor } from "../../../../src/sharing/server";

export const dynamic = "force-dynamic";

/** A guest's edit of a document, through a link's cookie (ROADMAP 1c.6). Under `/doc/<id>` because that is where the cookie is sent. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const config = authConfig();
  if (!config.enabled) return new Response(null, { status: 404 });
  return handleGuestDraft(request, { origin: config.url, save: saveGuestDraftFor }, (await params).id);
}
