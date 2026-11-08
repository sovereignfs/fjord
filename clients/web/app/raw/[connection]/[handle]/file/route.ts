import { handleRawFile } from '../../../../../src/browse/raw';
import { rawContext } from '../../../../../src/browse/raw-server';

// Who is asking is decided per request, from their cookies.
export const dynamic = 'force-dynamic';

/** A file of one of the account's own repositories, to look at or to save (`src/browse/raw.ts`). `?download` asks for it as a file even when it is a picture. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ connection: string; handle: string }> },
): Promise<Response> {
  const { connection, handle } = await params;
  const { caller, deps } = await rawContext();
  return handleRawFile(caller, connection, handle, deps, {
    download: new URL(request.url).searchParams.has('download'),
  });
}
