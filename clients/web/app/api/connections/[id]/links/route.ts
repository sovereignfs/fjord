import { linksContext } from "../../../../../src/sharing/context";
import { handleLinks } from "../../../../../src/sharing/links-http";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await linksContext();
  if (!context) return new Response(null, { status: 404 });
  return handleLinks(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as GET, handle as POST };
