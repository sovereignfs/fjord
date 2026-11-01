import { handleAddVault } from "../../../../../src/connections/http";
import { connectionContext } from "../../../../../src/connections/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await connectionContext();
  if (!context) return new Response(null, { status: 404 });
  return handleAddVault(request, context.caller, context.deps, (await params).id);
}
