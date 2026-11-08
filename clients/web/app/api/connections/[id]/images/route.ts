import { handleImages } from '../../../../../src/site/images-http';
import { imagesContext } from '../../../../../src/site/images-server';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Params): Promise<Response> {
  const context = await imagesContext();
  if (!context) return new Response(null, { status: 404 });
  return handleImages(request, context.caller, context.deps, (await params).id);
}

/** A site's pictures, and the posts that show one (`?uses=`). */
export const GET = handle;
/** Add pictures: a multipart form of `files`. */
export const POST = handle;
/** Take one away. */
export const DELETE = handle;
