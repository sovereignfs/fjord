import { afterEach, describe, expect, it, vi } from "vitest";
import { guestAttemptFrom, sendGuestDraft } from "./guest-client";

/** What each answer to a guest's save means to the saver (ROADMAP 1c.6). */
describe("guestAttemptFrom", () => {
  it("keeps what was kept", () => {
    expect(guestAttemptFrom(200, { })).toEqual({ kind: "kept" });
  });

  it.each([["bad_name", true], ["read_only", true], ["not_editable", true], ["too_many_drafts", true], ["too_many_editors", true]])("%s stops the saving, in words", (code, stop) => {
    expect(guestAttemptFrom(code === "read_only" ? 403 : 422, { error: { code, message: "words" } })).toMatchObject({ kind: "refused", stop, message: expect.any(String) });
  });

  it("refuses a text that cannot be kept without stopping: the next change may fix it", () => {
    expect(guestAttemptFrom(422, { error: { code: "unstorable", message: "It has a NUL." } })).toEqual({ kind: "refused", stop: false, message: "It has a NUL." });
    expect(guestAttemptFrom(413, { error: { code: "too_large" } })).toMatchObject({ kind: "refused", stop: false });
  });

  it("stops when the link no longer works, and says what is still on the page", () => {
    for (const status of [403, 404]) expect(guestAttemptFrom(status, { error: { code: "not_found" } })).toMatchObject({ kind: "refused", stop: true, message: expect.stringMatching(/no longer works/) });
  });

  it("tries again when the server or the network is unwell", () => {
    for (const status of [500, 502, 503, 429]) expect(guestAttemptFrom(status, undefined)).toEqual({ kind: "failed" });
  });
});

describe("sendGuestDraft", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts the name and the body to the document's own draft address, and nothing else", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ savedAt: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendGuestDraft("01jagc4k7pt8y3wqnmzv5xrb8j", "Grace Hopper", "# Plan\n")).toEqual({ kind: "kept" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/doc/01jagc4k7pt8y3wqnmzv5xrb8j/draft");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Grace Hopper", body: "# Plan\n" });
    expect(init.credentials).toBe("same-origin");
  });

  it("fails, to be tried again, when it cannot reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await sendGuestDraft("01jagc4k7pt8y3wqnmzv5xrb8j", "Grace", "x")).toEqual({ kind: "failed" });
  });
});
