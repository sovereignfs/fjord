import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { GuestSave } from "./guest";
import { type Deps, handleGuestDraft, shareCookieOf } from "./guest-http";

/**
 * Editing through a link over HTTP (ROADMAP 1c.6): who may call, from where, with what, and what they are told. Whether a link may edit and
 * what becomes of the text is `guest.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const COOKIE = `theme=dark; fjord_share=${"T".repeat(43)}; other=1`;

function stub(result: GuestSave = { ok: true, savedAt: 123 }) {
  const save = vi.fn(async (..._args: unknown[]): Promise<GuestSave> => result);
  const deps: Deps = { save: (input) => save(input), origin: ORIGIN };
  return { deps, save };
}
const put = (body: unknown, init: { origin?: string | null; type?: string | null; cookie?: string | null; method?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  if (init.cookie !== null) headers.cookie = init.cookie ?? COOKIE;
  const method = init.method ?? "PUT";
  return new Request(`${ORIGIN}/doc/${DOC}/draft`, { method, headers, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
};
const good = { name: "Grace Hopper", body: "# Plan\n\nText.\n" };
const text = async (response: Response) => JSON.parse(await response.text());

describe("what is sent", () => {
  it("is the cookie, the name and the body, handed on whole, and answers when it was kept", async () => {
    const { deps, save } = stub();
    const response = await handleGuestDraft(put({ ...good, path: "Notes/x.md", editor: "owner" }), deps, DOC);
    expect(response.status).toBe(200);
    expect(await text(response)).toEqual({ savedAt: 123 });
    expect(save).toHaveBeenCalledWith({ cookie: "T".repeat(43), docId: DOC, name: "Grace Hopper", body: "# Plan\n\nText.\n" });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("finds the share cookie among others, and none when it is not there", () => {
    expect(shareCookieOf(COOKIE)).toBe("T".repeat(43));
    expect(shareCookieOf(`fjord_share=a.b`)).toBe("a.b");
    for (const header of [null, "", "theme=dark", "fjord_share_pending=abc", "xfjord_share=abc"]) expect(shareCookieOf(header), String(header)).toBeUndefined();
  });

  it("must come from this site, as a PUT of JSON, and not be far too large", async () => {
    const { deps, save } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) expect((await handleGuestDraft(put(good, { origin }), deps, DOC)).status).toBe(403);
    for (const method of ["POST", "GET", "DELETE", "PATCH"]) expect((await handleGuestDraft(put(good, { method }), deps, DOC)).status).toBe(405);
    for (const type of ["text/plain", null]) expect((await handleGuestDraft(put(good, { type }), deps, DOC)).status).toBe(415);
    for (const bad of ["{nope", "[]", "null", "7"]) expect((await handleGuestDraft(put(bad), deps, DOC)).status).toBe(400);
    expect((await handleGuestDraft(put({ ...good, body: "x".repeat(1024 * 1024 + 5000) }), deps, DOC)).status).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });

  it("is a 404 for a document that is not an id, before anything is asked, and a 400 for a body that is not text", async () => {
    const { deps, save } = stub();
    for (const id of ["nope", "../x", DOC.toUpperCase(), `${DOC}0`]) expect((await handleGuestDraft(put(good), deps, id)).status, id).toBe(404);
    for (const body of [undefined, 7, null, ["x"]]) expect((await handleGuestDraft(put({ name: "Grace", body }), deps, DOC)).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("hands on a missing cookie, which the layer below turns away like any wrong one", async () => {
    const { deps, save } = stub({ ok: false, reason: "hidden" });
    const response = await handleGuestDraft(put(good, { cookie: null }), deps, DOC);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cookie: undefined }));
    expect(response.status).toBe(404);
  });
});

describe("what they are told", () => {
  it.each<[Exclude<GuestSave, { ok: true }>, number, string]>([
    [{ ok: false, reason: "hidden" }, 404, "not_found"],
    [{ ok: false, reason: "forbidden" }, 403, "read_only"],
    [{ ok: false, reason: "bad_name" }, 400, "bad_name"],
    [{ ok: false, reason: "not_editable" }, 422, "not_editable"],
    [{ ok: false, reason: "unstorable", message: "It has a NUL." }, 422, "unstorable"],
    [{ ok: false, reason: "too_many_drafts" }, 422, "too_many_drafts"],
    [{ ok: false, reason: "too_many_editors" }, 422, "too_many_editors"],
    [{ ok: false, reason: "unavailable" }, 502, "unavailable"],
  ])("%j is %i %s, in words", async (result, status, code) => {
    const { deps } = stub(result);
    const response = await handleGuestDraft(put(good), deps, DOC);
    expect(response.status).toBe(status);
    const error = (await text(response)).error;
    expect(error.code).toBe(code);
    expect(error.message.length).toBeGreaterThan(15);
  });

  it("says how long to wait when the link is used faster than anyone types", async () => {
    const { deps, save } = stub();
    save.mockResolvedValueOnce({ ok: false, reason: "rate_limited", retryAfterMs: 12_500 } as never);
    const response = await handleGuestDraft(put(good), deps, DOC);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("13");
    expect((await text(response)).error.code).toBe("rate_limited");
  });

  it("says when the instance cannot read repositories, when the host is limiting, and answers the unexpected plainly without the cookie", async () => {
    const { deps, save } = stub();
    save.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleGuestDraft(put(good), deps, DOC)).status).toBe(503);
    save.mockRejectedValueOnce(new ProviderError("rate_limited", "slow"));
    expect((await handleGuestDraft(put(good), deps, DOC)).status).toBe(429);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    save.mockRejectedValueOnce(new Error(`cookie ${"T".repeat(43)} at postgres://user:hunter2@db`));
    const response = await handleGuestDraft(put(good), deps, DOC);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/hunter2|TTTT/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/hunter2|TTTT/);
    logged.mockRestore();
  });
});
