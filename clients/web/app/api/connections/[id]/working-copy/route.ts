import { handleWorkingCopy } from "../../../../../src/working/http";
import { workingCopyContext } from "../../../../../src/working/context";

export const dynamic = "force-dynamic";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await workingCopyContext();
  if (!context) return new Response(null, { status: 404 });
  return handleWorkingCopy(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as PUT };
