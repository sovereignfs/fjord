import { afterEach, describe, expect, it, vi } from "vitest";
import { addShare, createLink, createdFrom, doneFrom, failureFrom, fromLocalInput, linksFrom, listLinks, listShares, removeShare, revokeLink, sharedFrom, sharesFrom, toLocalInput, updateLink } from "./manage-client";

/** What the Sharing panel sends, and what each answer means to it (ROADMAP 1c.7). */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";

describe("what an answer means", () => {
  it("lists what the server listed", () => {
    expect(sharesFrom(200, { shares: [{ accountId: "a", name: "Grace", email: "g@example.com", role: "view" }] })).toEqual({ ok: true, shares: [{ accountId: "a", name: "Grace", email: "g@example.com", role: "view" }] });
    expect(linksFrom(200, { links: [] })).toEqual({ ok: true, links: [] });
    expect(sharesFrom(200, {})).toMatchObject({ ok: false });
    expect(linksFrom(200, undefined)).toMatchObject({ ok: false });
  });

  it("takes the server's words for a refusal, else its own, and says when signed out", () => {
    expect(failureFrom(422, { error: { message: "Only documents can be shared." } }, "the sharing")).toEqual({ ok: false, message: "Only documents can be shared." });
    expect(failureFrom(500, undefined, "the links").message).toMatch(/Nothing was changed/);
    expect(failureFrom(401, undefined, "the sharing").message).toMatch(/signed out/);
  });

  it("hands on the one answer that sharing gives, whoever the address is", () => {
    expect(sharedFrom(200, { status: "ok", message: "If that address has an account here, the document is now shared with it." })).toMatchObject({ ok: true, message: expect.stringMatching(/If that address/) });
    expect(sharedFrom(400, { error: { message: "Say who to share with." } })).toEqual({ ok: false, message: "Say who to share with." });
  });

  it("hands on a new link's token and address, from the 201 alone", () => {
    expect(createdFrom(201, { id: 7, token: "T", url: "https://x/doc/d?token=T", passwordProtected: true })).toEqual({ ok: true, id: 7, token: "T", url: "https://x/doc/d?token=T", passwordProtected: true });
    expect(createdFrom(200, { id: 7, token: "T", url: "u" })).toMatchObject({ ok: false });
    expect(createdFrom(201, { id: 7 })).toMatchObject({ ok: false });
    expect(createdFrom(201, { id: 7, token: "T", url: "u" })).toMatchObject({ ok: true, passwordProtected: false });
  });

  it("says whether a removal, revocation or change did anything", () => {
    expect(doneFrom(200, { removed: false }, "removed")).toEqual({ ok: true, changed: false });
    expect(doneFrom(200, { revoked: true }, "revoked")).toEqual({ ok: true, changed: true });
    expect(doneFrom(409, { error: { message: "That link is gone." } }, "updated")).toEqual({ ok: false, message: "That link is gone." });
    expect(doneFrom(200, { revoked: true }, "removed")).toMatchObject({ ok: false });
  });
});

describe("what is sent", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const sent = (fetchMock: ReturnType<typeof stub>) => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials };
  };

  it("asks for the lists by document, to the connection's own addresses", async () => {
    let fetchMock = stub(200, { shares: [] });
    await listShares(3, DOC);
    expect(sent(fetchMock)).toMatchObject({ url: `/api/connections/3/shares?doc=${DOC}`, method: "GET", credentials: "same-origin" });
    fetchMock = stub(200, { links: [] });
    await listLinks(3, DOC);
    expect(sent(fetchMock)).toMatchObject({ url: `/api/connections/3/links?doc=${DOC}`, method: "GET" });
  });

  it("shares, and stops sharing, by the address and the account", async () => {
    let fetchMock = stub(200, { message: "ok" });
    await addShare(3, DOC, "grace@example.com", "comment");
    expect(sent(fetchMock)).toMatchObject({ url: "/api/connections/3/shares", method: "POST", body: { doc: DOC, email: "grace@example.com", role: "comment" } });
    fetchMock = stub(200, { removed: true });
    await removeShare(3, DOC, "acc-1");
    expect(sent(fetchMock)).toMatchObject({ method: "DELETE", body: { doc: DOC, accountId: "acc-1" } });
  });

  it("makes a link with only what was given, changes one with only what was named, and revokes by number", async () => {
    let fetchMock = stub(201, { id: 1, token: "T", url: "u" });
    await createLink(3, DOC, { role: "view", expiresAt: null, password: null });
    expect(sent(fetchMock).body).toEqual({ doc: DOC, role: "view" });
    fetchMock = stub(201, { id: 1, token: "T", url: "u" });
    await createLink(3, DOC, { role: "edit", expiresAt: 123, password: "correct horse battery staple" });
    expect(sent(fetchMock).body).toEqual({ doc: DOC, role: "edit", expiresAt: 123, password: "correct horse battery staple" });
    fetchMock = stub(200, { updated: true });
    await updateLink(3, DOC, 9, { expiresAt: null, password: null });
    expect(sent(fetchMock)).toMatchObject({ method: "PATCH", body: { doc: DOC, linkId: 9, expiresAt: null, password: null } });
    fetchMock = stub(200, { revoked: true });
    await revokeLink(3, DOC, 9);
    expect(sent(fetchMock)).toMatchObject({ method: "DELETE", body: { doc: DOC, linkId: 9 } });
  });

  it("says nothing was changed when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    for (const result of [await listShares(3, DOC), await addShare(3, DOC, "a@b.c", "view"), await createLink(3, DOC, { role: "view", expiresAt: null, password: null }), await updateLink(3, DOC, 1, { role: "view" }), await revokeLink(3, DOC, 1)]) {
      expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/could not reach this server/i) });
    }
  });
});

describe("times in the page's inputs", () => {
  it("round-trip in the person's own zone, with none as empty", () => {
    const ms = new Date(2026, 9, 28, 14, 5).getTime();
    expect(toLocalInput(ms)).toBe("2026-10-28T14:05");
    expect(fromLocalInput("2026-10-28T14:05")).toBe(ms);
    expect(toLocalInput(null)).toBe("");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("  ")).toBeNull();
    expect(fromLocalInput("not a time")).toBeUndefined();
  });
});
