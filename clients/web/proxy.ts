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
 */
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/" && getSessionCookie(request, { cookiePrefix: "fjord" })) {
    return NextResponse.rewrite(new URL("/home", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/"] };
