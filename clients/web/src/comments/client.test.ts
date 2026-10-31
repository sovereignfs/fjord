import { afterEach, describe, expect, it, vi } from "vitest";
import { addReply, deleteComment, editComment, eventsAddress, failureFrom, listingFrom, loadComments, madeFrom, setClosed, setResolved, startThread, versionFrom } from "./client";

/** What the comments panel sends, and what each answer means to it (ROADMAP 1d.1). */
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const ANCHOR = { type: "text-quote" as const, quote: "world", prefix: "Hello ", suffix: "", position: 6 };

describe("what an answer means", () => {
  it("is a listing when it has threads, whether closed, and who is asking", () => {
    const body = { threads: [], closed: false, viewer: { role: "view", canComment: false, canModerate: false, name: null } };
    expect(listingFrom(200, body)).toMatchObject({ ok: true, listing: { closed: false, threads: [] } });
    expect(listingFrom(200, { threads: [] })).toMatchObject({ ok: false });
    expect(listingFrom(404, { error: { code: "not_found", message: "There is no such document." } })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is made when the server says so, with the new comment's number if it gave one", () => {
    expect(madeFrom(201, { ok: true, id: 7 })).toEqual({ ok: true, id: 7 });
    expect(madeFrom(200, { ok: true })).toEqual({ ok: true, id: undefined });
    expect(madeFrom(201, {})).toMatchObject({ ok: false });
  });

  it("takes the server's words and code for a refusal, and says when a document is no longer reachable", () => {
    expect(failureFrom(409, { error: { code: "closed", message: "Comments on this document are closed." } })).toEqual({ ok: false, code: "closed", message: "Comments on this document are closed." });
    expect(failureFrom(404, { error: { code: "not_found" } })).toMatchObject({ code: "not_found", message: expect.stringMatching(/no longer have access/) });
    expect(failureFrom(500, undefined).message).toMatch(/Nothing was changed/);
  });
});

describe("the live stream", () => {
  it("is under the document's comments, where a link's cookie is sent", () => {
    expect(eventsAddress(DOC)).toBe(`/doc/${DOC}/comments/events`);
  });

  it("says a version, or nothing for what does not say one", () => {
    expect(versionFrom('{"version":12}')).toBe(12);
    expect(versionFrom('{"version":0}')).toBe(0);
    for (const bad of ["{}", "{nope", '{"version":"12"}', '{"version":-1}', '{"version":1.5}', "null", "[]", undefined]) expect(versionFrom(bad), String(bad)).toBeUndefined();
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
  const claim = { name: "Grace", clientId: "abcdefgh" };

  it("asks for the comments at the document's own address, saying who it is only if it can", async () => {
    let fetchMock = stub(200, { threads: [], closed: false, viewer: {} });
    await loadComments(DOC, claim);
    expect(sent(fetchMock)).toMatchObject({ url: `/doc/${DOC}/comments?name=Grace&client=abcdefgh`, method: "GET", credentials: "same-origin" });
    fetchMock = stub(200, { threads: [], closed: false, viewer: {} });
    await loadComments(DOC, {});
    expect(sent(fetchMock).url).toBe(`/doc/${DOC}/comments`);
  });

  it("starts a thread, replies, resolves, edits, deletes and closes, each with what it needs and who is asking", async () => {
    let fetchMock = stub(201, { ok: true, id: 1 });
    await startThread(DOC, ANCHOR, "a thought", claim);
    expect(sent(fetchMock)).toMatchObject({ method: "POST", body: { op: "thread", anchor: ANCHOR, body: "a thought", ...claim } });
    fetchMock = stub(201, { ok: true });
    await addReply(DOC, 4, "yes", claim);
    expect(sent(fetchMock)).toMatchObject({ method: "POST", body: { op: "reply", thread: 4, body: "yes", ...claim } });
    fetchMock = stub(200, { ok: true });
    await setResolved(DOC, 4, true, claim);
    expect(sent(fetchMock)).toMatchObject({ method: "PATCH", body: { op: "resolve", thread: 4, resolved: true } });
    fetchMock = stub(200, { ok: true });
    await editComment(DOC, "reply", 9, "better", {});
    expect(sent(fetchMock)).toMatchObject({ method: "PATCH", body: { op: "edit", kind: "reply", id: 9, body: "better" } });
    fetchMock = stub(200, { ok: true });
    await deleteComment(DOC, "thread", 4, claim);
    expect(sent(fetchMock)).toMatchObject({ method: "DELETE", body: { kind: "thread", id: 4, ...claim } });
    fetchMock = stub(200, { ok: true });
    await setClosed(DOC, true);
    expect(sent(fetchMock)).toMatchObject({ method: "PATCH", body: { op: "close", closed: true } });
  });

  it("says nothing was changed when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    for (const result of [await loadComments(DOC, {}), await startThread(DOC, ANCHOR, "x", claim), await addReply(DOC, 1, "x", claim), await setClosed(DOC, true)]) {
      expect(result).toMatchObject({ ok: false, code: "unreachable", message: expect.stringMatching(/could not reach this server/i) });
    }
  });
});
