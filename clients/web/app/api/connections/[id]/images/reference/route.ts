import { handleImageReference } from "../../../../../../src/site/images-http";
import { imagesContext } from "../../../../../../src/site/images-server";

export const dynamic = "force-dynamic";

/** How a post refers to a picture, and what a reference in a post means (`?post=` with `image=` or `reference=`). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await imagesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleImageReference(request, context.caller, context.deps, (await params).id);
}
