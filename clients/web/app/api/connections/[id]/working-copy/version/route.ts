import { handleVersion } from "../../../../../../src/working/http";
import { workingCopyContext } from "../../../../../../src/working/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await workingCopyContext();
  if (!context) return new Response(null, { status: 404 });
  return handleVersion(request, context.caller, context.deps, (await params).id);
}
