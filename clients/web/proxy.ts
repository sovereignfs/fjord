import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { PATH_HEADER } from "./src/auth/next";
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
 * **A share link's first request is not a page** (DESIGN.md §12, ROADMAP 1c.4): `/d/<id>?token=…` is handed to
 * `/api/links/enter`, which swaps the token for a cookie scoped to that document and redirects to the clean `/d/<id>`, so the
 * token does not stay in the address bar, the history or a `Referer`. Nothing is looked up here: the proxy only sees that
 * there is a token. **The rewrite names no token**: Next puts the rewritten address in a response header (`x-middleware-rewrite`),
 * where a token would be sent back out, so the entry reads the document and the token from the address as it was asked for.
 */
export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  const secure = (process.env.FJORD_URL ?? "").startsWith("https://");

  // A page is sent with a policy that has this request's own nonce (DESIGN.md §15, ROADMAP 1d.5); Next reads it from the request's copy of the header and puts the
  // nonce on the scripts and styles it makes, and the layout puts it on the theme script (`x-nonce`). An API's answer is data, with no page to protect.
  // `/raw/…` is a sandboxed document with a policy of its own (`src/browse/raw.ts`), which a page policy here would replace.
  const page = !pathname.startsWith("/api/") && !pathname.startsWith("/raw/");
  const nonce = newNonce();
  // The one page that shows such a document in a frame: `/<kind>/<repo>/v/<vault>/…/html/<handle>`.
  const frames = /^\/(?:drive|journal|ssg)\/[0-9a-hjkmnp-tv-z]{8}\/v\/[^/]+\/(?:[^/]+\/)?html\/[0-9a-z]{16}$/.test(pathname);
  const policy = contentSecurityPolicy({ nonce, secure, development: process.env.NODE_ENV === "development", frames });
  const requestHeaders = new Headers(request.headers);
  if (page) {
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", policy);
    // Where the person was going, for the sign-in page to go on to (`src/auth/next.ts`). It is what a client sent, so a page never trusts one it did not get from here, and it never holds a token.
    requestHeaders.delete(PATH_HEADER);
    if (!searchParams.has("token")) requestHeaders.set(PATH_HEADER, pathname + request.nextUrl.search);
  }
  const marked = (response: NextResponse): NextResponse => {
    if (page) response.headers.set("content-security-policy", policy);
    if (secure) response.headers.set("strict-transport-security", HSTS);
    return response;
  };

  if (pathname === "/" && getSessionCookie(request, { cookiePrefix: "fjord" })) {
    return marked(NextResponse.rewrite(new URL("/home", request.url), { request: { headers: requestHeaders } }));
  }
  // A share link: `/d/<id>?token=`, or `/doc/<id>?token=` as links were given before the routes were shortened. Either way the entry swaps the token for a
  // cookie and sends the person to `/d/<id>`, so a link already in someone's hands keeps working.
  const shared = /^\/(?:d|doc|n)\/([^/]+)$/.exec(pathname);
  if (shared && searchParams.has("token")) {
    return marked(NextResponse.rewrite(new URL("/api/links/enter", request.url), { request: { headers: requestHeaders } }));
  }
  // The routes' old names, for a bookmark or a link with no token in it: sent on for good to `/d/<id>`, with the query as it was. (`/note/` and `/n/`
  // were a note's, which is no different from a document since RFC 0002: there is one kind of Doc.)
  const old = /^\/(?:doc|note)\/([^/]+)$/.exec(pathname);
  if (old) {
    const target = new URL(`/d/${old[1]}`, request.url);
    target.search = request.nextUrl.search;
    // Nothing that is a token goes into an address by way of a redirect: a link's token is only ever swapped for a cookie, by the entry above.
    target.searchParams.delete("token");
    return marked(NextResponse.redirect(target, 308));
  }
  return marked(NextResponse.next({ request: { headers: requestHeaders } }));
}

/** Everything but the build's own static files, which are not pages and are the same for everyone (and cannot carry a nonce). */
export const config = { matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icon.svg).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }] };
