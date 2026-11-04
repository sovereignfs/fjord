import { localContext } from "../../../../../src/local/context";
import { handleSync } from "../../../../../src/local/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await localContext();
  if (!context) return new Response(null, { status: 404 });
  return handleSync(request, context.caller, context.deps, (await params).id);
}
