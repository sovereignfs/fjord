import { previewContext } from '../../../../../src/site/preview-context';
import { handlePreviews } from '../../../../../src/site/preview-http';

export const dynamic = 'force-dynamic';

async function answer(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await previewContext();
  if (!context) return new Response(null, { status: 404 });
  return handlePreviews(request, context.caller, context.deps, (await params).id);
}

export const GET = answer;
export const POST = answer;
export const DELETE = answer;
