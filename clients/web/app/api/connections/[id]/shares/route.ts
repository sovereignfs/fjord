import { handleShares } from "../../../../../src/sharing/http";
import { sharingContext } from "../../../../../src/sharing/context";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await sharingContext();
  if (!context) return new Response(null, { status: 404 });
  return handleShares(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as GET, handle as POST };
