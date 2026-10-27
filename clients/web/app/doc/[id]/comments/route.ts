import { commentsContext } from "../../../../src/comments/server";
import { handleComments } from "../../../../src/comments/http";

export const dynamic = "force-dynamic";

/** A document's comments (ROADMAP 1d.1). Under `/doc/<id>` because that is where a link's cookie is sent; a session works anywhere. */
async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await commentsContext();
  if (!context) return new Response(null, { status: 404 });
  return handleComments(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
