import { recipientsContext } from "../../../../../src/encrypted/context";
import { handleRecipients } from "../../../../../src/encrypted/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await recipientsContext();
  if (!context) return new Response(null, { status: 404 });
  return handleRecipients(request, context.caller, context.deps, (await params).id);
}
