import { filesContext } from '../../../../../../src/files/context';
import { handleConvert, handleConvertSource } from '../../../../../../src/files/http';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await filesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleConvert(request, context.caller, context.deps, (await params).id);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const context = await filesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleConvertSource(request, context.caller, context.deps, (await params).id);
}
