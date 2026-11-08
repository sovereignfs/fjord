import { handleImageFile } from "../../../../../../src/site/images-http";
import { imagesContext } from "../../../../../../src/site/images-server";

export const dynamic = "force-dynamic";

/** One picture's bytes (`?path=`), as the type its first bytes say. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await imagesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleImageFile(request, context.caller, context.deps, (await params).id);
}
