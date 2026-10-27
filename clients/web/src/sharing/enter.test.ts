import { describe, expect, it, vi } from "vitest";
import type { LinkWithSecret } from "./links";
import { COOKIE_MAX_AGE_SECONDS, type EnterDeps, PENDING_MAX_AGE_SECONDS, clearPendingCookie, handleEnter, pendingCookie, shareCookie } from "./enter";
import { newToken } from "./tokens";

/**
 * Entering by a share link (ROADMAP 1c.4): the token is swapped for a cookie of that document, and the person is sent to the clean
 * address. What matters is what is in the cookie, what is not in the redirect, and that nothing says whether a token worked.
 */
const NOW = 1_800_000_000_000;
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const OTHER = "01jagc4k7pt8y3wqnmzv5xrbzz";
const TOKEN = newToken();

const link = (over: Partial<LinkWithSecret> = {}): LinkWithSecret => ({ id: 1, connectionId: 1, docId: DOC, role: "view", expiresAt: null, revokedAt: null, createdAt: NOW - 1000, hasPassword: false, passwordHash: null, failures: 0, lockedUntil: null, ...over });
function deps(found: LinkWithSecret | undefined, over: Partial<EnterDeps> = {}) {
  const byToken = vi.fn(async (..._args: unknown[]) => found);
  return { deps: { links: { byToken }, secure: false, now: () => NOW, ...over } as EnterDeps, byToken };
}
const at = (query: string, method = "GET") => new Request(`https://fjord.example.com/api/links/enter${query}`, { method });
const enter = (token: string | null, doc: string | null = DOC) => at(`?${[doc === null ? "" : `doc=${doc}`, token === null ? "" : `token=${token}`].filter(Boolean).join("&")}`);

describe("a token that works", () => {
  it("is swapped for a cookie of that document and a redirect to its clean address, with nothing of the token in the redirect", async () => {
    const { deps: d } = deps(link());
    const response = await handleEnter(enter(TOKEN), d);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/doc/${DOC}`);
    expect(await response.text()).toBe("");
    const everythingElse = [...response.headers.entries()].filter(([name]) => name !== "set-cookie").flat().join(" ");
    expect(everythingElse).not.toContain(TOKEN);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sets a cookie the page's script cannot read, for that document's path alone, that lasts an hour at most", async () => {
    const { deps: d } = deps(link());
    const cookie = (await handleEnter(enter(TOKEN), d)).headers.get("set-cookie")!;
    expect(cookie).toBe(`fjord_share=${TOKEN}; Path=/doc/${DOC}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`);
    expect(COOKIE_MAX_AGE_SECONDS).toBe(3600);
  });

  it("is Secure when the instance is on https, and not when it is not", async () => {
    expect((await handleEnter(enter(TOKEN), deps(link(), { secure: true }).deps)).headers.get("set-cookie")).toMatch(/; Secure$/);
    expect((await handleEnter(enter(TOKEN), deps(link(), { secure: false }).deps)).headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("lasts no longer than the link does, and not at all if it is about to end", async () => {
    expect((await handleEnter(enter(TOKEN), deps(link({ expiresAt: NOW + 90_000 })).deps)).headers.get("set-cookie")).toMatch(/Max-Age=90;/);
    expect((await handleEnter(enter(TOKEN), deps(link({ expiresAt: NOW + 5 * 3600_000 })).deps)).headers.get("set-cookie")).toMatch(/Max-Age=3600;/);
    expect((await handleEnter(enter(TOKEN), deps(link({ expiresAt: NOW + 900 })).deps)).headers.get("set-cookie")).toBeNull();
  });

  it("builds the cookie as a function of the document and the token alone", () => {
    expect(shareCookie(DOC, "abc", 60, true)).toBe(`fjord_share=abc; Path=/doc/${DOC}; Max-Age=60; HttpOnly; SameSite=Lax; Secure`);
  });
});

describe("a link with a password", () => {
  const protectedLink = (over: Partial<LinkWithSecret> = {}) => link({ hasPassword: true, passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$x", ...over });

  it("gets no cookie that opens it: its token waits ten minutes in a pending one, for that document, and the redirect is the clean address", async () => {
    const response = await handleEnter(enter(TOKEN), deps(protectedLink()).deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/doc/${DOC}`);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual([`fjord_share_pending=${TOKEN}; Path=/doc/${DOC}; Max-Age=${PENDING_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`]);
    expect(PENDING_MAX_AGE_SECONDS).toBe(600);
    expect(cookies.join(" ")).not.toMatch(/fjord_share=/);
  });

  it("waits no longer than the link lives, and is Secure on https", async () => {
    expect((await handleEnter(enter(TOKEN), deps(protectedLink({ expiresAt: NOW + 30_000 })).deps)).headers.get("set-cookie")).toMatch(/Max-Age=30;/);
    expect((await handleEnter(enter(TOKEN), deps(protectedLink(), { secure: true }).deps)).headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("is told from one without a password by the name of the cookie alone", async () => {
    const strip = (response: Response) => [response.status, response.headers.get("location"), [...response.headers.keys()].sort()];
    expect(strip(await handleEnter(enter(TOKEN), deps(protectedLink()).deps))).toEqual(strip(await handleEnter(enter(TOKEN), deps(link()).deps)));
  });

  it("builds the pending cookie, and the one that ends it, for the document alone", () => {
    expect(pendingCookie(DOC, "abc", 60, true)).toBe(`fjord_share_pending=abc; Path=/doc/${DOC}; Max-Age=60; HttpOnly; SameSite=Lax; Secure`);
    expect(clearPendingCookie(DOC, false)).toBe(`fjord_share_pending=; Path=/doc/${DOC}; Max-Age=0; HttpOnly; SameSite=Lax`);
  });
});

describe("a token that does not", () => {
  const cases: [string, LinkWithSecret | undefined, string | null][] = [
    ["was never made", undefined, TOKEN],
    ["is for another document", link({ docId: OTHER }), TOKEN],
    ["has expired", link({ expiresAt: NOW - 1 }), TOKEN],
    ["expires this instant", link({ expiresAt: NOW }), TOKEN],
    ["was revoked", link({ revokedAt: NOW - 5 }), TOKEN],
    ["is not a token", link(), "not a token"],
    ["is absent", link(), null],
  ];
  it.each(cases)("%s: the same redirect to the clean address, with no cookie", async (_name, found, token) => {
    const { deps: d } = deps(found);
    const response = await handleEnter(enter(token), d);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/doc/${DOC}`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect([...response.headers.values()].join(" ")).not.toContain(TOKEN);
  });

  it("is told apart from one that works by the cookie alone, which only the holder sees", async () => {
    const good = await handleEnter(enter(TOKEN), deps(link()).deps);
    const bad = await handleEnter(enter(TOKEN), deps(undefined).deps);
    const strip = (response: Response) => [response.status, response.headers.get("location"), [...response.headers.keys()].filter((name) => name !== "set-cookie").sort()];
    expect(strip(bad)).toEqual(strip(good));
  });

  it("does not look a token up unless it looks like one", async () => {
    const { deps: d, byToken } = deps(link());
    await handleEnter(enter("short"), d);
    expect(byToken).not.toHaveBeenCalled();
  });
});

describe("the address it is given", () => {
  it("names the document by its path as well, for a server that hands over the address as asked for", async () => {
    const response = await handleEnter(new Request(`https://fjord.example.com/doc/${DOC}?token=${TOKEN}`), deps(link()).deps);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/doc/${DOC}`);
    expect(response.headers.get("set-cookie")).toContain(`Path=/doc/${DOC}`);
  });

  it("takes the path's document over a `doc`, which is for a request made to the route itself, and nothing else for a document", async () => {
    const response = await handleEnter(new Request(`https://fjord.example.com/doc/${DOC}?doc=${OTHER}&token=${TOKEN}`), deps(link()).deps);
    expect(response.headers.get("location")).toBe(`/doc/${DOC}`);
    expect((await handleEnter(new Request(`https://fjord.example.com/elsewhere/${DOC}?token=${TOKEN}`), deps(link()).deps)).status).toBe(404);
  });
});

describe("what is asked of it", () => {
  it("is a 404 for a document that is not an id, with no redirect and no cookie, whatever the token", async () => {
    for (const doc of [null, "nope", "../x", DOC.toUpperCase(), `${DOC}0`]) {
      const response = await handleEnter(enter(TOKEN, doc), deps(link()).deps);
      expect(response.status, String(doc)).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("is a GET (or a HEAD), and nothing else", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await handleEnter(at(`?doc=${DOC}&token=${TOKEN}`, method), deps(link()).deps)).status).toBe(405);
    expect((await handleEnter(at(`?doc=${DOC}&token=${TOKEN}`, "HEAD"), deps(link()).deps)).status).toBe(303);
  });
});
