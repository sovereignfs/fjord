import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

/** What the proxy does with a request (ROADMAP 1c.4): a share link's first request goes to the place that swaps its token for a cookie. */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const TOKEN = "x".repeat(43);
const request = (path: string, init: { headers?: Record<string, string> } = {}) => new NextRequest(`https://fjord.example.com${path}`, init);
const rewrittenTo = (response: Response) => response.headers.get("x-middleware-rewrite");

describe("a share link's first request", () => {
  it("is rewritten to the entry, and the rewrite names neither the document nor the token (Next sends it back out in a response header)", () => {
    const response = proxy(request(`/doc/${DOC}?token=${TOKEN}`));
    expect(rewrittenTo(response)).toBe("/api/links/enter");
    expect([...response.headers.entries()].flat().join(" ")).not.toContain(TOKEN);
  });

  it("is that whatever else is in the query, and even if the token is empty (the entry then does nothing)", () => {
    expect(rewrittenTo(proxy(request(`/doc/${DOC}?a=1&token=${TOKEN}&b=2`)))).toBe("/api/links/enter");
    expect(rewrittenTo(proxy(request(`/doc/${DOC}?token=`)))).toBe("/api/links/enter");
  });

  it("is only a document's own address with a token: anything else goes on as it was", () => {
    for (const path of [`/doc/${DOC}`, `/doc/${DOC}?x=1`, `/note/${DOC}?token=${TOKEN}`, `/doc/${DOC}/more?token=${TOKEN}`, "/doc/?token=x"]) expect(rewrittenTo(proxy(request(path))), path).toBeNull();
  });

  it("is looked for on `/` and on a document's address, and on nothing else", () => {
    expect(config.matcher).toEqual(["/", "/doc/:id"]);
  });
});

describe("the landing page", () => {
  it("is still `/home` for someone with a session cookie, and the landing page for a visitor", () => {
    expect(rewrittenTo(proxy(request("/")))).toBeNull();
    expect(new URL(rewrittenTo(proxy(request("/", { headers: { cookie: "fjord.session_token=abc.def" } })))!).pathname).toBe("/home");
  });
});
