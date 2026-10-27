import { decide } from "../access/policy";
import { isDocId } from "../browse/ids";
import type { LinkService } from "./links";
import { PENDING_COOKIE, SHARE_COOKIE } from "./redact";
import { TOKEN_PATTERN } from "./tokens";

/**
 * Entering by a share link (DESIGN.md §12, ROADMAP 1c.4). A link's address is `/doc/<id>?token=<token>`, and a token left in the
 * address bar stays in the history, in a bookmark, in a screenshot and in any log of the address. So the first request is
 * not a page: `proxy.ts` hands it here, and the answer is a cookie and a redirect to the clean `/doc/<id>`.
 *
 *  - **The cookie is for that document and no other** (its path is `/doc/<id>`), `HttpOnly` (a script on the page cannot read it),
 *    `SameSite=Lax`, `Secure` when the instance is on https, and **short-lived**: an hour at most, and no longer than the link has to
 *    live. It holds the token, which the page checks against the store on every request, so revoking a link, or its expiry,
 *    ends what it opened on the next one.
 *  - **A link with a password** (ROADMAP 1c.5) gets no cookie that lets anyone in: its token waits, for ten minutes, in a pending
 *    cookie, and the page it is sent to asks for the password (`unlock.ts`). The cookie that opens it is only given when the password is right.
 *  - **The answer is the same for a token that works and one that does not**: a redirect to the clean address, where the page
 *    is what it is for anyone. Only a token that works comes with the cookie. Nothing says which it was, and the token is in
 *    neither the redirect nor the body.
 *  - `Referrer-Policy: no-referrer` and `no-store` on it, so that neither the address that carried the token nor this answer is
 *    passed on or kept.
 */
export interface EnterDeps {
  links: Pick<LinkService, "byToken">;
  /** Whether the instance is on https, so that the cookie is `Secure`. */
  secure: boolean;
  now?: () => number;
}

/** How long a cookie lasts at most, in seconds. */
export const COOKIE_MAX_AGE_SECONDS = 60 * 60;
/** How long a password link's token waits in its cookie for the password to be given. */
export const PENDING_MAX_AGE_SECONDS = 10 * 60;

/** The `Set-Cookie` of a token for a document: exported for the page's tests and for `e2e`'s reading of it. `value` is the token, and for a link with a password the token and the proof that the password was given (`password.ts`). */
export function shareCookie(docId: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SHARE_COOKIE}=${value}; Path=/doc/${docId}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The cookie a password link's token waits in while its password is asked for (ROADMAP 1c.5): the same scope, and shorter. It lets nobody in. */
export function pendingCookie(docId: string, token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${PENDING_COOKIE}=${token}; Path=/doc/${docId}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** A cookie that ends the pending one, once the password is right. */
export function clearPendingCookie(docId: string, secure: boolean): string {
  return `${PENDING_COOKIE}=; Path=/doc/${docId}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export async function handleEnter(request: Request, deps: EnterDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const url = new URL(request.url);
  const params = url.searchParams;
  // The proxy rewrites `/doc/<id>?token=` to this route and the route is handed the address as it was asked for (the rewrite names
  // no token, since Next sends the rewritten address back in a response header), so the document is the path's. A request made
  // to this route directly names it as `doc`.
  const docId = /^\/doc\/([^/]+)$/.exec(url.pathname)?.[1] ?? params.get("doc") ?? null;
  const token = params.get("token");
  if (docId === null || !isDocId(docId)) return new Response(null, { status: 404, headers: { "referrer-policy": "no-referrer", "cache-control": "no-store" } });

  const headers = new Headers({ location: `/doc/${docId}`, "referrer-policy": "no-referrer", "cache-control": "no-store" });
  const now = deps.now?.() ?? Date.now();
  const link = token !== null && TOKEN_PATTERN.test(token) ? await deps.links.byToken(token) : undefined;
  if (token !== null && link && link.docId === docId) {
    const grant = { kind: "link", role: link.role, expiresAt: link.expiresAt, revoked: link.revokedAt !== null } as const;
    if (decide([grant], "read", { kind: "document" }, now) === "allow") {
      const remaining = link.expiresAt === null ? COOKIE_MAX_AGE_SECONDS : Math.floor((link.expiresAt - now) / 1000);
      // A link with a password lets nobody in with its token alone: the token waits in a cookie that opens nothing, and the page asks.
      const age = Math.min(link.hasPassword ? PENDING_MAX_AGE_SECONDS : COOKIE_MAX_AGE_SECONDS, remaining);
      if (age > 0) headers.append("set-cookie", link.hasPassword ? pendingCookie(docId, token, age, deps.secure) : shareCookie(docId, token, age, deps.secure));
    }
  }
  return new Response(null, { status: 303, headers });
}
