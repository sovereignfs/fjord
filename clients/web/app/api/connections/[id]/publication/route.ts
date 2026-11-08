import { handlePublication } from '../../../../../src/publishing/http';
import { publishingContext } from '../../../../../src/publishing/server';

export const dynamic = 'force-dynamic';

async function handle(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await publishingContext();
  if (!context) return new Response(null, { status: 404 });
  return handlePublication(request, context.caller, context.deps, (await params).id);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST };
