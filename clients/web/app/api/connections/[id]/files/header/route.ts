import { filesContext } from "../../../../../../src/files/context";
import { handleHeader } from "../../../../../../src/files/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await filesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleHeader(request, context.caller, context.deps, (await params).id);
}
