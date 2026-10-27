import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Caller } from "../working/http";
import { type CreateResult, type Deps, type LinkSummary, MAX_EXPIRY_MS, handleLinks, linkUrl } from "./links-http";

/**
 * Who may call `/api/connections/<id>/links`, from where, with what, and what they are told: the rules of `links-http.ts` with
 * a stand-in for what is behind it. Whose it is and what has a link is `links-access.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const NOW = 1_800_000_000_000;
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const TOKEN = "T".repeat(43);
const good = { doc: DOC, role: "view" };

function stub() {
  const create = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: CreateResult }> => ({ found: true, result: { ok: true, id: 7, token: TOKEN } }));
  const list = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; links: LinkSummary[] }> => ({
    found: true,
    links: [{ id: 7, role: "view", expiresAt: null, revokedAt: null, createdAt: NOW, status: "active", passwordProtected: false }],
  }));
  const revoke = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; revoked: boolean }> => ({ found: true, revoked: true }));
  const deps: Deps = { create: (a, i, x) => create(a, i, x), list: (a, i, d) => list(a, i, d), revoke: (a, i, x) => revoke(a, i, x), origin: ORIGIN, now: () => NOW };
  return { deps, create, list, revoke };
}

const req = (method: string, body?: unknown, init: { origin?: string | null; type?: string | null; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (body !== undefined && init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/links${init.query ?? ""}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe.each([
  ["GET", undefined, `?doc=${DOC}`],
  ["POST", good, ""],
  ["DELETE", { doc: DOC, linkId: 7 }, ""],
] as const)("%s: who may", (method, sent, query) => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, create, list, revoke } = stub();
    expect((await handleLinks(req(method, sent, { query }), null, deps, "1")).status).toBe(401);
    for (const mock of [create, list, revoke]) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "-1", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, create, list, revoke } = stub();
    expect((await handleLinks(req(method, sent, { query }), ALICE, deps, id)).status).toBe(404);
    for (const mock of [create, list, revoke]) expect(mock).not.toHaveBeenCalled();
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, create, list, revoke } = stub();
    for (const mock of [create, list, revoke]) mock.mockResolvedValue({ found: false });
    const response = await handleLinks(req(method, sent, { query }), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });
});

describe.each([["POST", good], ["DELETE", { doc: DOC, linkId: 7 }]] as const)("%s: what changes something", (method, sent) => {
  it("must come from this site", async () => {
    const { deps, create, revoke } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) expect((await handleLinks(req(method, sent, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("must be JSON, an object, and not far too large", async () => {
    const { deps } = stub();
    for (const type of ["text/plain", null]) expect((await handleLinks(req(method, sent, { type }), ALICE, deps, "1")).status).toBe(415);
    for (const text of ["{nope", "[]"]) expect((await handleLinks(req(method, text), ALICE, deps, "1")).status).toBe(400);
    expect((await handleLinks(req(method, { ...sent, extra: "y".repeat(2000) }), ALICE, deps, "1")).status).toBe(413);
  });
});

describe("making a link", () => {
  it("answers the token once, with the address to open it at, and asks for the caller's own connection", async () => {
    const { deps, create } = stub();
    const response = await handleLinks(req("POST", { ...good, role: "comment", author: "mallory", token: "chosen" }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ id: 7, token: TOKEN, url: `${ORIGIN}/doc/${DOC}?token=${TOKEN}`, passwordProtected: false });
    expect(create).toHaveBeenCalledWith("alice", 1, { docId: DOC, role: "comment", expiresAt: null, password: null });
  });

  it("takes an expiry in the future, and no other", async () => {
    const { deps, create } = stub();
    expect((await handleLinks(req("POST", { ...good, expiresAt: NOW + 1000 }), ALICE, deps, "1")).status).toBe(201);
    expect(create).toHaveBeenLastCalledWith("alice", 1, expect.objectContaining({ expiresAt: NOW + 1000 }));
    expect((await handleLinks(req("POST", { ...good, expiresAt: null }), ALICE, deps, "1")).status).toBe(201);
    create.mockClear();
    for (const expiresAt of [NOW, NOW - 1, 0, -5, 1.5, "tomorrow", NOW + MAX_EXPIRY_MS + 1, Number.MAX_SAFE_INTEGER + 2, true]) {
      expect((await handleLinks(req("POST", { ...good, expiresAt }), ALICE, deps, "1")).status, String(expiresAt)).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["no document", { ...good, doc: undefined }],
    ["a document that is not an id", { ...good, doc: "../x" }],
    ["no role", { ...good, role: undefined }],
    ["a role that is not one", { ...good, role: "owner" }],
    ["a role in capitals", { ...good, role: "VIEW" }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, create } = stub();
    expect((await handleLinks(req("POST", sent), ALICE, deps, "1")).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("takes a password of a fit length, hands it on as the owner's, and says only that the link has one", async () => {
    const { deps, create } = stub();
    const response = await handleLinks(req("POST", { ...good, password: "correct horse battery staple" }), ALICE, deps, "1");
    const text = await response.text();
    expect(response.status).toBe(201);
    expect(JSON.parse(text).passwordProtected).toBe(true);
    expect(text).not.toContain("correct horse");
    expect(create).toHaveBeenCalledWith("alice", 1, expect.objectContaining({ password: "correct horse battery staple" }));
    create.mockClear();
    for (const password of [null, undefined]) expect((await handleLinks(req("POST", { ...good, password }), ALICE, deps, "1")).status).toBe(201);
    expect(create).toHaveBeenLastCalledWith("alice", 1, expect.objectContaining({ password: null }));
  });

  it("refuses a password that is not text, is too short or too long, or has a NUL, without asking", async () => {
    const { deps, create } = stub();
    create.mockClear();
    for (const password of ["short", "x".repeat(201), 12345678, ["abcdefgh"], "abcdefg\u0000h", "abcdefg\ud800", true]) {
      expect((await handleLinks(req("POST", { ...good, password }), ALICE, deps, "1")).status, JSON.stringify(password)).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("never carries the password in an unexpected failure's log", async () => {
    const { deps, create } = stub();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    create.mockRejectedValueOnce(new Error("boom"));
    const response = await handleLinks(req("POST", { ...good, password: "correct horse battery staple" }), ALICE, deps, "1");
    expect(await response.text()).not.toContain("correct horse");
    expect(logged.mock.calls.flat().join(" ")).not.toContain("correct horse");
    logged.mockRestore();
  });

  it.each<[Extract<CreateResult, { ok: false }>["reason"], number]>([["not_a_document", 422], ["gone", 404], ["too_many", 422], ["unavailable", 502]])(
    "%s is %i, with its own code and words, and no token",
    async (reason, status) => {
      const { deps, create } = stub();
      create.mockResolvedValue({ found: true, result: { ok: false, reason } });
      const response = await handleLinks(req("POST", good), ALICE, deps, "1");
      const text = await response.text();
      expect(response.status).toBe(status);
      expect(JSON.parse(text).error.code).toBe(reason);
      expect(text).not.toContain(TOKEN);
    },
  );

  it("builds the address on the instance's own origin, whatever slash it ends in", () => {
    expect(linkUrl("https://f.example/", DOC, TOKEN)).toBe(`https://f.example/doc/${DOC}?token=${TOKEN}`);
    expect(linkUrl("https://f.example", DOC, TOKEN)).toBe(`https://f.example/doc/${DOC}?token=${TOKEN}`);
  });
});

describe("listing, revoking, and what goes wrong", () => {
  it("lists a document's links, which carry no token", async () => {
    const { deps, list } = stub();
    const response = await handleLinks(req("GET", undefined, { query: `?doc=${DOC}` }), ALICE, deps, "1");
    const text = await response.text();
    expect(JSON.parse(text).links).toEqual([{ id: 7, role: "view", expiresAt: null, revokedAt: null, createdAt: NOW, status: "active", passwordProtected: false }]);
    expect(text).not.toMatch(/token/i);
    expect(list).toHaveBeenCalledWith("alice", 1, DOC);
    for (const query of ["", "?doc=nope", `?doc=${DOC.toUpperCase()}`]) expect((await handleLinks(req("GET", undefined, { query }), ALICE, deps, "1")).status).toBe(400);
  });

  it("revokes a link by its number, and refuses anything else", async () => {
    const { deps, revoke } = stub();
    expect(await body(await handleLinks(req("DELETE", { doc: DOC, linkId: 7 }), ALICE, deps, "1"))).toEqual({ revoked: true });
    expect(revoke).toHaveBeenCalledWith("alice", 1, { docId: DOC, linkId: 7 });
    for (const linkId of [undefined, "7", 0, -1, 1.5, null]) expect((await handleLinks(req("DELETE", { doc: DOC, linkId }), ALICE, deps, "1")).status).toBe(400);
  });

  it("only GET, POST and DELETE", async () => {
    const { deps } = stub();
    for (const method of ["PUT", "PATCH"]) expect((await handleLinks(req(method, good), ALICE, deps, "1")).status).toBe(405);
  });

  it("says when the instance cannot read repositories, when the host is limiting, and answers the unexpected plainly, never with a token", async () => {
    const { deps, create } = stub();
    create.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleLinks(req("POST", good), ALICE, deps, "1")).status).toBe(503);
    create.mockRejectedValueOnce(new ProviderError("rate_limited", "slow down"));
    expect((await handleLinks(req("POST", good), ALICE, deps, "1")).status).toBe(429);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    create.mockRejectedValueOnce(new Error(`token ${TOKEN} at postgres://user:hunter2@db`));
    const response = await handleLinks(req("POST", good), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/hunter2|TTTT/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/hunter2|TTTT/);
    logged.mockRestore();
  });
});
