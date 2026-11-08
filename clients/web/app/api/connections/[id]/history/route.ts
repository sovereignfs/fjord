import { handleHistory } from '../../../../../src/browse/history-http';
import { historyContext } from '../../../../../src/browse/history-server';

// Who is asking is decided per request, from their cookies.
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await historyContext();
  return context
    ? handleHistory(request, context.caller, context.deps, (await params).id)
    : new Response(null, { status: 404 });
}
