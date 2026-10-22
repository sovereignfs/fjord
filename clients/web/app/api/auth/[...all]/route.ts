import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "../../../../src/auth/server";

// Every request is answered by better-auth, mounted at /api/auth. With local sign-in off
// there is nothing mounted: 404, as if the routes did not exist.
export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth ? toNextJsHandler(auth).GET(request) : notFound();
}

export async function POST(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth ? toNextJsHandler(auth).POST(request) : notFound();
}
