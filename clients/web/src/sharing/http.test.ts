import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Caller } from "../working/http";
import { type Deps, type ListResult, SHARED, type ShareResult, handleShares } from "./http";

/**
 * Who may call `/api/connections/<id>/shares`, from where, with what, and what they are told: the rules of `http.ts` with a
 * stand-in for what is behind it. Whose it is and what is shared is `access.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const good = { doc: DOC, email: "grace@example.com", role: "comment" };

function stub() {
  const share = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: ShareResult }> => ({ found: true, result: { ok: true } }));
  const list = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: ListResult }> => ({ found: true, result: { ok: true, shares: [{ accountId: "grace", name: "Grace", email: "grace@example.com", role: "view" }] } }));
  const unshare = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; removed: boolean } | { ok: false; reason: "unavailable" } }> => ({ found: true, result: { ok: true, removed: true } }));
  const deps: Deps = { share: (a, i, x) => share(a, i, x), list: (a, i, d) => list(a, i, d), unshare: (a, i, x) => unshare(a, i, x), origin: ORIGIN };
  return { deps, share, list, unshare };
}

const req = (method: string, body?: unknown, init: { origin?: string | null; type?: string | null; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (body !== undefined && init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/shares${init.query ?? ""}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe.each([
  ["GET", undefined, `?doc=${DOC}`],
  ["POST", good, ""],
  ["DELETE", { doc: DOC, accountId: "grace" }, ""],
] as const)("%s: who may", (method, sent, query) => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, share, list, unshare } = stub();
    expect((await handleShares(req(method, sent, { query }), null, deps, "1")).status).toBe(401);
    for (const mock of [share, list, unshare]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "-1", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, share, list, unshare } = stub();
    expect((await handleShares(req(method, sent, { query }), ALICE, deps, id)).status).toBe(404);
    for (const mock of [share, list, unshare]) expect(mock).not.toHaveBeenCalled();
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, share, list, unshare } = stub();
    for (const mock of [share, list, unshare]) mock.mockResolvedValue({ found: false });
    const response = await handleShares(req(method, sent, { query }), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });
});

describe.each([
  ["POST", good],
  ["DELETE", { doc: DOC, accountId: "grace" }],
] as const)("%s: what changes something", (method, sent) => {
  it("must come from this site", async () => {
    const { deps, share, unshare } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) expect((await handleShares(req(method, sent, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect(share).not.toHaveBeenCalled();
    expect(unshare).not.toHaveBeenCalled();
  });

  it("must be JSON, an object, and not far too large", async () => {
    const { deps } = stub();
    for (const type of ["text/plain", null]) expect((await handleShares(req(method, sent, { type }), ALICE, deps, "1")).status).toBe(415);
    for (const text of ["{nope", "[]"]) expect((await handleShares(req(method, text), ALICE, deps, "1")).status).toBe(400);
    expect((await handleShares(req(method, { ...sent, extra: "y".repeat(3000) }), ALICE, deps, "1")).status).toBe(413);
  });
});

describe("what may be sent", () => {
  it("shares for the caller as their account names them, whatever else is in the request", async () => {
    const { deps, share } = stub();
    const response = await handleShares(req("POST", { ...good, email: "  grace@example.com ", author: "mallory", accountId: "mallory" }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(SHARED);
    expect(share).toHaveBeenCalledWith("alice", 1, { docId: DOC, email: "grace@example.com", role: "comment" });
  });

  it.each([
    ["no document", { ...good, doc: undefined }],
    ["a document that is not an id", { ...good, doc: "../etc/passwd" }],
    ["an id in capitals", { ...good, doc: DOC.toUpperCase() }],
    ["no address", { ...good, email: undefined }],
    ["an address that is not text", { ...good, email: 7 }],
    ["an address with no @", { ...good, email: "grace" }],
    ["an address with two @", { ...good, email: "a@b@c" }],
    ["an address with a space in it", { ...good, email: "gra ce@example.com" }],
    ["an address with a line break", { ...good, email: "grace@example.com\nbcc: x@y.z" }],
    ["an address that is too long", { ...good, email: `${"a".repeat(250)}@example.com` }],
    ["an address that is only an @", { ...good, email: "@" }],
    ["no role", { ...good, role: undefined }],
    ["a role that is not one", { ...good, role: "owner" }],
    ["a role in capitals", { ...good, role: "EDIT" }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, share } = stub();
    expect((await handleShares(req("POST", sent), ALICE, deps, "1")).status).toBe(400);
    expect(share).not.toHaveBeenCalled();
  });

  it.each(["view", "comment", "edit"])("takes the role %s", async (role) => {
    const { deps, share } = stub();
    expect((await handleShares(req("POST", { ...good, role }), ALICE, deps, "1")).status).toBe(200);
    expect(share).toHaveBeenCalledWith("alice", 1, expect.objectContaining({ role }));
  });

  it("answers the same words, byte for byte, however the share went", async () => {
    // The answer does not depend on whether the address has an account: the layer below says ok for both (access.test.ts).
    const { deps } = stub();
    const a = await (await handleShares(req("POST", good), ALICE, deps, "1")).text();
    const b = await (await handleShares(req("POST", { ...good, email: "nobody@example.com" }), ALICE, deps, "1")).text();
    expect(b).toBe(a);
  });

  it("lists who a document is shared with, and needs the document", async () => {
    const { deps, list } = stub();
    const response = await handleShares(req("GET", undefined, { query: `?doc=${DOC}` }), ALICE, deps, "1");
    expect(await body(response)).toEqual({ shares: [{ accountId: "grace", name: "Grace", email: "grace@example.com", role: "view" }] });
    expect(list).toHaveBeenCalledWith("alice", 1, DOC);
    for (const query of ["", "?doc=nope", `?doc=${DOC.toUpperCase()}`]) expect((await handleShares(req("GET", undefined, { query }), ALICE, deps, "1")).status).toBe(400);
  });

  it("stops sharing with an account named by its id, and refuses anything else", async () => {
    const { deps, unshare } = stub();
    expect(await body(await handleShares(req("DELETE", { doc: DOC, accountId: "grace" }), ALICE, deps, "1"))).toEqual({ removed: true });
    expect(unshare).toHaveBeenCalledWith("alice", 1, { docId: DOC, accountId: "grace" });
    for (const accountId of [undefined, 7, "", "a b", "../x", "x".repeat(200)]) expect((await handleShares(req("DELETE", { doc: DOC, accountId }), ALICE, deps, "1")).status).toBe(400);
  });

  it("only GET, POST and DELETE", async () => {
    const { deps } = stub();
    for (const method of ["PUT", "PATCH"]) expect((await handleShares(req(method, good), ALICE, deps, "1")).status).toBe(405);
  });
});

describe("what they are told when it is refused", () => {
  it.each<[Extract<ShareResult, { ok: false }>["reason"], number]>([
    ["not_a_document", 422],
    ["gone", 404],
    ["too_many", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words", async (reason, status) => {
    const { deps, share } = stub();
    share.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleShares(req("POST", good), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(15);
  });

  it("says when the instance cannot read repositories, when the host is limiting, and answers the unexpected plainly", async () => {
    const { deps, share } = stub();
    share.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleShares(req("POST", good), ALICE, deps, "1")).status).toBe(503);
    share.mockRejectedValueOnce(new ProviderError("rate_limited", "slow down"));
    expect((await handleShares(req("POST", good), ALICE, deps, "1")).status).toBe(429);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    share.mockRejectedValueOnce(new Error("token github_pat_SECRET at postgres://user:hunter2@db"));
    const response = await handleShares(req("POST", good), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|hunter2/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/SECRET|hunter2/);
    logged.mockRestore();
  });
});
