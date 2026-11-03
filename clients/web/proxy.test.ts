import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

/** What the proxy does with a request (ROADMAP 1c.4): a share link's first request goes to the place that swaps its token for a cookie. */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const TOKEN = "x".repeat(43);
const request = (path: string, init: { headers?: Record<string, string> } = {}) => new NextRequest(`https://fjord.example.com${path}`, init);
const rewrittenTo = (response: Response) => {
  const header = response.headers.get("x-middleware-rewrite");
  return header === null ? null : new URL(header).pathname;
};

describe("a share link's first request", () => {
  it("is rewritten to the entry, and the rewrite names neither the document nor the token (Next sends it back out in a response header)", () => {
    const response = proxy(request(`/d/${DOC}?token=${TOKEN}`));
    expect(rewrittenTo(response)).toBe("/api/links/enter");
    expect([...response.headers.entries()].flat().join(" ")).not.toContain(TOKEN);
  });

  it("is that whatever else is in the query, and even if the token is empty (the entry then does nothing)", () => {
    expect(rewrittenTo(proxy(request(`/d/${DOC}?a=1&token=${TOKEN}&b=2`)))).toBe("/api/links/enter");
    expect(rewrittenTo(proxy(request(`/d/${DOC}?token=`)))).toBe("/api/links/enter");
  });

  it("is also a link given before the route was shortened: /doc/<id>?token= still enters", () => {
    const response = proxy(request(`/doc/${DOC}?token=${TOKEN}`));
    expect(rewrittenTo(response)).toBe("/api/links/enter");
    expect(response.status).not.toBe(308);
    expect([...response.headers.entries()].flat().join(" ")).not.toContain(TOKEN);
  });

  it("is also a journal's note at /n/<id>, which the entry sends back to /n/<id>", () => {
    const response = proxy(request(`/n/${DOC}?token=${TOKEN}`));
    expect(rewrittenTo(response)).toBe("/api/links/enter");
    expect(response.status).not.toBe(308);
    expect([...response.headers.entries()].flat().join(" ")).not.toContain(TOKEN);
  });

  it("is only a document's own address with a token: anything else goes on as it was", () => {
    for (const path of [`/d/${DOC}`, `/d/${DOC}?x=1`, `/n/${DOC}`, `/d/${DOC}/more?token=${TOKEN}`, `/n/${DOC}/more?token=${TOKEN}`, "/d/?token=x"]) expect(rewrittenTo(proxy(request(path))), path).toBeNull();
  });

  it("is looked for on every request but the build's static files and prefetches, which cannot carry a nonce", () => {
    const [matcher] = config.matcher as { source: string; missing: unknown[] }[];
    const matches = (path: string) => new RegExp(`^${matcher!.source}$`).test(path);
    for (const path of ["/", `/d/${DOC}`, `/d/${DOC}/comments`, `/doc/${DOC}`, "/api/health", "/sign-in", `/repo/1/Notes/a.md`]) expect(matches(path), path).toBe(true);
    for (const path of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/icon.svg"]) expect(matches(path), path).toBe(false);
    expect(matcher!.missing).toEqual([{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }]);
  });
});

describe("the routes' old names (/doc/<id> and /note/<id>; /n/<id> is a journal's note since workstream 0003)", () => {
  const redirect = (path: string) => {
    const response = proxy(request(path));
    return { status: response.status, to: response.headers.get("location") };
  };

  it("are sent on for good to /d/<id>, whatever is in the query", () => {
    expect(redirect(`/doc/${DOC}`)).toEqual({ status: 308, to: `https://fjord.example.com/d/${DOC}` });
    expect(redirect(`/note/${DOC}`)).toEqual({ status: 308, to: `https://fjord.example.com/d/${DOC}` });
    // `/n/<id>` is a page now, and is not sent on.
    expect(redirect(`/n/${DOC}`).status).not.toBe(308);
    expect(redirect(`/doc/${DOC}?wrong=1`)).toEqual({ status: 308, to: `https://fjord.example.com/d/${DOC}?wrong=1` });
  });

  it("never carry a token into an address by a redirect: a Doc's token is swapped for a cookie, not passed on", () => {
    const note = redirect(`/note/${DOC}?token=${TOKEN}&x=1`);
    expect(note.to).toBe(`https://fjord.example.com/d/${DOC}?x=1`);
    expect(note.to).not.toContain(TOKEN);
  });

  it("are only those three addresses: anything deeper, or another name, is left alone", () => {
    for (const path of [`/doc/${DOC}/comments`, `/doc/${DOC}/draft`, "/doc/", "/doc", `/notes/${DOC}`, `/documents/${DOC}`, `/d/${DOC}`, `/n/${DOC}/x`]) expect(redirect(path).status, path).not.toBe(308);
  });

  it("are sent with the page's policy too", () => {
    expect(proxy(request(`/doc/${DOC}`)).headers.get("content-security-policy")).toContain("nonce-");
  });
});

describe("the landing page", () => {
  it("is still `/home` for someone with a session cookie, and the landing page for a visitor", () => {
    expect(rewrittenTo(proxy(request("/")))).toBeNull();
    expect(rewrittenTo(proxy(request("/", { headers: { cookie: "fjord.session_token=abc.def" } })))).toBe("/home");
  });
});

describe("the Content-Security-Policy (ROADMAP 1d.5)", () => {
  const policyOf = (response: Response) => response.headers.get("content-security-policy")!;
  const nonceOf = (policy: string) => /'nonce-([^']+)'/.exec(policy)![1]!;

  it("is sent with every page, with a nonce that is in the request's copy too, for Next and the layout to use", () => {
    for (const path of ["/", `/d/${DOC}`, "/sign-in", "/repo/1"]) {
      const response = proxy(request(path));
      const policy = policyOf(response);
      expect(policy, path).toContain("script-src 'self' 'nonce-");
      expect(response.headers.get("x-middleware-request-x-nonce"), path).toBe(nonceOf(policy));
      expect(response.headers.get("x-middleware-request-content-security-policy"), path).toBe(policy);
    }
  });

  it("has a nonce of its own for every request, 128 bits of it", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => nonceOf(policyOf(proxy(request("/sign-in"))))));
    expect(nonces.size).toBe(50);
    expect(Buffer.from([...nonces][0]!, "base64")).toHaveLength(16);
  });

  it("is not sent with an API's answer, which is data and has no page to protect", () => {
    expect(proxy(request("/api/health")).headers.get("content-security-policy")).toBeNull();
    expect(proxy(request("/api/health")).headers.get("x-middleware-request-x-nonce")).toBeNull();
  });

  it("is sent with the rewrites too: the signed-in landing page, and the first request of a share link", () => {
    expect(policyOf(proxy(request("/", { headers: { cookie: "fjord.session_token=abc.def" } })))).toContain("nonce-");
    expect(policyOf(proxy(request(`/d/${DOC}?token=${TOKEN}`)))).toContain("nonce-");
  });
});
