import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { HSTS, contentSecurityPolicy, newNonce } from "./src/security/csp";

/**
 * `/` is the landing page for a visitor and the repository view for someone signed in
 * (DESIGN.md §3), at the same address. Whether there is a session cookie is cheap to see
 * here, so a signed-in person is shown `/home` in its place, without the address changing;
 * whether the session is real is for the page to check (`requireSession`), since a cookie
 * can be stale or forged and a proxy should not be the only thing standing in the way.
 *
 * **Every page is sent with a Content-Security-Policy** with a nonce of its own (`src/security/csp.ts`), so every page is rendered per request, the landing page too.
 *
 * **A share link's first request is not a page** (DESIGN.md §12, ROADMAP 1c.4): `/doc/<id>?token=…` is handed to
 * `/api/links/enter`, which swaps the token for a cookie scoped to that document and redirects to the clean `/doc/<id>`, so the
 * token does not stay in the address bar, the history or a `Referer`. Nothing is looked up here: the proxy only sees that
 * there is a token. **The rewrite names no token**: Next puts the rewritten address in a response header (`x-middleware-rewrite`),
 * where a token would be sent back out, so the entry reads the document and the token from the address as it was asked for.
 */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const secure = (process.env.FJORD_URL ?? "").startsWith("https://");

  // A page is sent with a policy that has this request's own nonce (DESIGN.md §15, ROADMAP 1d.5); Next reads it from the request's copy of the header and puts the
  // nonce on the scripts and styles it makes, and the layout puts it on the theme script (`x-nonce`). An API's answer is data, with no page to protect.
  const page = !pathname.startsWith("/api/");
  const nonce = newNonce();
  const policy = contentSecurityPolicy({ nonce, secure, development: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  if (page) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", policy);
  }
  const marked = (response: NextResponse): NextResponse => {
    if (page) response.headers.set("content-security-policy", policy);
    if (secure) response.headers.set("strict-transport-security", HSTS);
    return response;
  };

  if (pathname === "/" && getSessionCookie(request, { cookiePrefix: "fjord" })) {
    return marked(NextResponse.rewrite(new URL("/home", request.url), { request: { headers: requestHeaders } }));
  }
  const doc = /^\/doc\/([^/]+)$/.exec(pathname);
  if (doc && searchParams.has("token")) {
    return marked(NextResponse.rewrite(new URL("/api/links/enter", request.url), { request: { headers: requestHeaders } }));
  }
  return marked(NextResponse.next({ request: { headers: requestHeaders } }));
}

/** Everything but the build's own static files, which are not pages and are the same for everyone (and cannot carry a nonce). */
export const config = { matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }] };
