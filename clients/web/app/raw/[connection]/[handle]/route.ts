import { handleRaw } from "../../../../src/browse/raw";
import { rawContext } from "../../../../src/browse/raw-server";

// Who is asking is decided per request, from their cookies.
export const dynamic = "force-dynamic";

/** A static HTML page of one of the account's own repositories, to run in a sandbox (`src/browse/raw.ts`); the page that shows it is `/repo/<repo>/v/<vault>/…/html/<handle>`. */
export async function GET(_request: Request, { params }: { params: Promise<{ connection: string; handle: string }> }): Promise<Response> {
  const { connection, handle } = await params;
  const { caller, deps } = await rawContext();
  return handleRaw(caller, connection, handle, deps);
}
