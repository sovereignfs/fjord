import { handleConnections } from "../../../src/connections/http";
import { connectionContext } from "../../../src/connections/context";

// Who is asking is decided per request, from their cookies.
export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  const context = await connectionContext();
  return context ? handleConnections(request, context.caller, context.deps) : notFound();
}

export async function POST(request: Request): Promise<Response> {
  const context = await connectionContext();
  return context ? handleConnections(request, context.caller, context.deps) : notFound();
}
