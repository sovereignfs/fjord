import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

/**
 * `/` is the landing page for a visitor and the repository view for someone signed in
 * (DESIGN.md §3), at the same address. Whether there is a session cookie is cheap to see
 * here, so a signed-in person is shown `/home` in its place, without the address changing;
 * whether the session is real is for the page to check (`requireSession`), since a cookie
 * can be stale or forged and a proxy should not be the only thing standing in the way.
 *
 * The landing page stays static HTML for everyone else.
 *
 * **A share link's first request is not a page** (DESIGN.md §12, ROADMAP 1c.4): `/doc/<id>?token=…` is handed to
 * `/api/links/enter`, which swaps the token for a cookie scoped to that document and redirects to the clean `/doc/<id>`, so the
 * token does not stay in the address bar, the history or a `Referer`. Nothing is looked up here: the proxy only sees that
 * there is a token. **The rewrite names no token**: Next puts the rewritten address in a response header (`x-middleware-rewrite`),
 * where a token would be sent back out, so the entry reads the document and the token from the address as it was asked for.
 */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname === "/" && getSessionCookie(request, { cookiePrefix: "fjord" })) {
    return NextResponse.rewrite(new URL("/home", request.url));
  }
  const doc = /^\/doc\/([^/]+)$/.exec(pathname);
  if (doc && searchParams.has("token")) {
    return NextResponse.rewrite(new URL("/api/links/enter", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/doc/:id"] };
