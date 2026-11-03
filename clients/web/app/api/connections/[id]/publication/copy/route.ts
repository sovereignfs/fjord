import { handleCopy } from "../../../../../../src/publishing/copy-http";
import { copyContext } from "../../../../../../src/publishing/server";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await copyContext();
  if (!context) return new Response(null, { status: 404 });
  return handleCopy(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as GET, handle as POST };
