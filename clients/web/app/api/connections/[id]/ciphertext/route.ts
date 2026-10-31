import { ciphertextContext } from "../../../../../src/encrypted/context";
import { handleCiphertext } from "../../../../../src/encrypted/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const context = await ciphertextContext();
  if (!context) return new Response(null, { status: 404 });
  return handleCiphertext(request, context.caller, context.deps, (await params).id);
}
