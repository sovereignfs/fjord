import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Outcome } from "./access";
import { type Deps, handleComments } from "./http";

/**
 * A document's comments over HTTP (ROADMAP 1d.1): who may call, from where, with what, and what they are told. Which role may do what is
 * `access.test.ts`; what is kept is `service.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const ALICE = { accountId: "alice", name: "Alice" };
const COOKIE = `theme=dark; fjord_share=${"T".repeat(43)}`;
const ANCHOR = { type: "text-quote", quote: "world", prefix: "Hello ", suffix: "", position: 6 };

function stub(outcome: Outcome = { ok: true, id: 9 }) {
  const run = vi.fn(async (..._args: unknown[]): Promise<Outcome> => outcome);
  const deps: Deps = { origin: ORIGIN, run: (input) => run(input) };
  return { deps, run };
}
const req = (method: string, body?: unknown, init: { origin?: string | null; type?: string | null; cookie?: string | null; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null && method !== "GET") headers.origin = init.origin ?? ORIGIN;
  if (body !== undefined && init.type !== null) headers["content-type"] = init.type ?? "application/json";
  if (init.cookie !== null) headers.cookie = init.cookie ?? COOKIE;
  return new Request(`${ORIGIN}/doc/${DOC}/comments${init.query ?? ""}`, { method, headers, ...(body === undefined || method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe("who is asking", () => {
  it("is the session's account and the link's cookie, handed on together, and may be neither", async () => {
    const { deps, run } = stub({ ok: true, threads: [], closed: false, viewer: { role: "view", canComment: false, canModerate: false, name: null } });
    expect((await handleComments(req("GET"), ALICE, deps, DOC)).status).toBe(200);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ docId: DOC, account: { id: "alice", name: "Alice" }, cookie: "T".repeat(43) }));
    await handleComments(req("GET", undefined, { cookie: null }), null, deps, DOC);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ account: undefined, cookie: undefined }));
  });

  it("reads a guest's name and browser from the query when listing, and from the body when writing, and nothing of who wrote it from anywhere else", async () => {
    const { deps, run } = stub();
    await handleComments(req("GET", undefined, { query: "?name=Grace&client=abcdefgh" }), null, deps, DOC);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ claimed: { name: "Grace", clientId: "abcdefgh" } }));
    await handleComments(req("POST", { op: "thread", anchor: ANCHOR, body: "x", name: "Grace", clientId: "abcdefgh", author: "mallory", accountId: "alice" }), null, deps, DOC);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ claimed: { name: "Grace", clientId: "abcdefgh" }, account: undefined }));
  });
});

describe.each([["POST", { op: "thread", anchor: ANCHOR, body: "x" }], ["PATCH", { op: "resolve", thread: 1, resolved: true }], ["DELETE", { kind: "thread", id: 1 }]] as const)("%s: what changes something", (method, sent) => {
  it("must come from this site", async () => {
    const { deps, run } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) expect((await handleComments(req(method, sent, { origin }), ALICE, deps, DOC)).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("must be JSON, an object, and not far too large", async () => {
    const { deps, run } = stub();
    for (const type of ["text/plain", null]) expect((await handleComments(req(method, sent, { type }), ALICE, deps, DOC)).status).toBe(415);
    for (const text of ["{nope", "[]", "null"]) expect((await handleComments(req(method, text), ALICE, deps, DOC)).status).toBe(400);
    expect((await handleComments(req(method, { ...sent, body: "x".repeat(21_000) }), ALICE, deps, DOC)).status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the document", () => {
  it("is an id, else not found, before anything is asked", async () => {
    const { deps, run } = stub();
    for (const id of ["nope", "../x", DOC.toUpperCase(), `${DOC}0`]) expect((await handleComments(req("GET"), ALICE, deps, id)).status, id).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("only GET, POST, PATCH and DELETE", async () => {
    const { deps } = stub();
    for (const method of ["PUT", "OPTIONS"]) expect((await handleComments(req(method, {}), ALICE, deps, DOC)).status).toBe(405);
  });
});

describe("what is asked", () => {
  const ask = async (method: string, sent: unknown) => {
    const { deps, run } = stub();
    const response = await handleComments(req(method, sent), ALICE, deps, DOC);
    return { response, run };
  };

  it("makes a thread of an anchor and a text, keeping only what an anchor is", async () => {
    const { response, run } = await ask("POST", { op: "thread", anchor: { ...ANCHOR, extra: "dropped" }, body: "a thought" });
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ ok: true, id: 9 });
    expect(run.mock.calls[0]![0]).toMatchObject({ operation: { op: "thread", anchor: ANCHOR, body: "a thought" } });
  });

  it("replies, resolves, edits, deletes and closes, each with its own fields", async () => {
    expect((await ask("POST", { op: "reply", thread: 4, body: "yes" })).run.mock.calls[0]![0]).toMatchObject({ operation: { op: "reply", thread: 4, body: "yes" } });
    expect((await ask("PATCH", { op: "resolve", thread: 4, resolved: false })).run.mock.calls[0]![0]).toMatchObject({ operation: { op: "resolve", thread: 4, resolved: false } });
    expect((await ask("PATCH", { op: "edit", kind: "reply", id: 7, body: "better" })).run.mock.calls[0]![0]).toMatchObject({ operation: { op: "edit", target: { kind: "reply", id: 7 }, body: "better" } });
    expect((await ask("PATCH", { op: "close", closed: true })).run.mock.calls[0]![0]).toMatchObject({ operation: { op: "close", closed: true } });
    const gone = await ask("DELETE", { kind: "thread", id: 4 });
    expect(gone.response.status).toBe(200);
    expect(gone.run.mock.calls[0]![0]).toMatchObject({ operation: { op: "delete", target: { kind: "thread", id: 4 } } });
  });

  it("moves a thread onto the words its text was edited into, from one anchor to another, keeping only what an anchor is", async () => {
    const { response, run } = await ask("PATCH", { op: "reanchor", thread: 4, from: { ...ANCHOR, extra: 1 }, to: { ...ANCHOR, quote: "worlds" } });
    expect(response.status).toBe(200);
    expect(run.mock.calls[0]![0]).toMatchObject({ operation: { op: "reanchor", thread: 4, from: ANCHOR, to: { ...ANCHOR, quote: "worlds" } } });
  });

  it.each([
    ["POST", "no operation", {}],
    ["POST", "an operation of another method", { op: "resolve", thread: 1, resolved: true }],
    ["POST", "a thread with no anchor", { op: "thread", body: "x" }],
    ["POST", "a thread with an anchor that is not one", { op: "thread", anchor: { ...ANCHOR, quote: "" }, body: "x" }],
    ["POST", "a thread with an anchor of another type", { op: "thread", anchor: { ...ANCHOR, type: "yjs" }, body: "x" }],
    ["POST", "a thread with a body that is not text", { op: "thread", anchor: ANCHOR, body: 7 }],
    ["POST", "a reply to a thread that is not a number", { op: "reply", thread: "4", body: "x" }],
    ["POST", "a reply to thread 0", { op: "reply", thread: 0, body: "x" }],
    ["PATCH", "a resolve with no state", { op: "resolve", thread: 1 }],
    ["PATCH", "an edit of a kind that is not one", { op: "edit", kind: "comment", id: 1, body: "x" }],
    ["PATCH", "an edit with no text", { op: "edit", kind: "thread", id: 1 }],
    ["PATCH", "a close with no state", { op: "close" }],
    ["PATCH", "a move with no anchor to move to", { op: "reanchor", thread: 1, from: ANCHOR }],
    ["PATCH", "a move from an anchor that is not one", { op: "reanchor", thread: 1, from: { ...ANCHOR, quote: "" }, to: ANCHOR }],
    ["PATCH", "a move of a thread that is not a number", { op: "reanchor", thread: "1", from: ANCHOR, to: ANCHOR }],
    ["PATCH", "an operation that is not one", { op: "delete" }],
    ["DELETE", "a delete with no kind", { id: 1 }],
    ["DELETE", "a delete of a number that is not a whole one", { kind: "reply", id: 1.5 }],
  ])("refuses %s %s with 400, without asking", async (method, _name, sent) => {
    const { response, run } = await ask(method, sent);
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("what they are told when it is refused", () => {
  it.each<[Extract<Outcome, { ok: false }>["reason"], number, string]>([
    ["hidden", 404, "not_found"],
    ["forbidden", 403, "forbidden"],
    ["need_name", 400, "need_name"],
    ["closed", 409, "closed"],
    ["not_found", 404, "no_such_comment"],
    ["too_many", 422, "too_many"],
    ["bad_comment", 400, "bad_comment"],
    ["bad_anchor", 422, "bad_anchor"],
    ["stale", 409, "stale"],
    ["own_limit", 422, "own_limit"],
    ["rate_limited", 429, "rate_limited"],
  ])("%s is %i %s, in words", async (reason, status, code) => {
    const { deps } = stub({ ok: false, reason });
    for (const [method, sent] of [["GET", undefined], ["POST", { op: "reply", thread: 1, body: "x" }]] as const) {
      const response = await handleComments(req(method, sent), ALICE, deps, DOC);
      expect(response.status).toBe(status);
      const error = (await body(response)).error;
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(15);
    }
  });

  it("says how long to wait when it is too fast, in whole seconds, rounded up and at least one", async () => {
    for (const [ms, seconds] of [[12_500, "13"], [1, "1"], [60_000, "60"], [undefined, "1"]] as const) {
      const { deps } = stub({ ok: false, reason: "rate_limited", ...(ms === undefined ? {} : { retryAfterMs: ms }) });
      const response = await handleComments(req("POST", { op: "reply", thread: 1, body: "x" }), ALICE, deps, DOC);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(seconds);
    }
  });

  it("says nothing different for a document that is not there and one the person may not see", async () => {
    const { deps } = stub({ ok: false, reason: "hidden" });
    const a = await (await handleComments(req("GET"), null, deps, DOC)).text();
    const b = await (await handleComments(req("GET", undefined, { cookie: null }), ALICE, deps, DOC)).text();
    expect(b).toBe(a);
  });

  it("says when the instance cannot read repositories, when the host is limiting, and answers the unexpected plainly without the cookie", async () => {
    const { deps, run } = stub();
    run.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleComments(req("GET"), ALICE, deps, DOC)).status).toBe(503);
    run.mockRejectedValueOnce(new ProviderError("rate_limited", "slow"));
    expect((await handleComments(req("GET"), ALICE, deps, DOC)).status).toBe(429);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    run.mockRejectedValueOnce(new Error(`cookie ${"T".repeat(43)} at postgres://user:hunter2@db`));
    const response = await handleComments(req("GET"), ALICE, deps, DOC);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/hunter2|TTTT/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/hunter2|TTTT/);
    logged.mockRestore();
  });

  it("says the reply is not cacheable and passes no referrer", async () => {
    const { deps } = stub({ ok: true, threads: [], closed: false });
    const response = await handleComments(req("GET"), ALICE, deps, DOC);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
