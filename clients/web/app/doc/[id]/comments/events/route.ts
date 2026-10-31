import { eventsContext } from "../../../../../src/comments/server";
import { handleEvents } from "../../../../../src/comments/events";

export const dynamic = "force-dynamic";

/** The live stream of a document's comments (ROADMAP 1d.3): says that they changed, never what they are. Under `/doc/<id>` for a link's cookie. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await eventsContext();
  if (!context) return new Response(null, { status: 404 });
  return handleEvents(request, context.caller, context.deps, (await params).id);
}
