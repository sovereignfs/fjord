import { sealedManageContext } from "../../../../../src/sealed/context";
import { handleSealedShares } from "../../../../../src/sealed/http";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await sealedManageContext();
  if (!context) return new Response(null, { status: 404 });
  return handleSealedShares(request, context.caller, context.deps, (await params).id);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
