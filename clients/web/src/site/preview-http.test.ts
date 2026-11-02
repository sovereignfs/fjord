import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../providers/errors";
import { type Caller, type Deps, handlePreviews } from "./preview-http";

/** Who may call `/api/connections/<id>/previews`, from where, with what, and what they are told (ROADMAP 3d.1): the rules, with a stand-in for what is behind them. */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };

function stub() {
  const list = vi.fn(async (..._a: unknown[]): ReturnType<Deps["list"]> => ({ found: true, result: { ok: true, listing: { previews: [], pending: { files: ["content/posts/a.md"], skipped: [] } } } }));
  const start = vi.fn(async (..._a: unknown[]): ReturnType<Deps["start"]> => ({ found: true, result: { ok: true, branch: "fjord/preview/abc-20261102t220000z", commit: "c".repeat(40), files: ["content/posts/a.md"], skipped: [] } }));
  const stop = vi.fn(async (..._a: unknown[]): ReturnType<Deps["stop"]> => ({ found: true, result: { ok: true } }));
  const deps: Deps = { origin: ORIGIN, list: (a, i) => list(a, i), start: (a, i, author) => start(a, i, author), stop: (a, i, b) => stop(a, i, b) };
  return { deps, list, start, stop };
}
const call = (method: string, init: { origin?: string | null; query?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return new Request(`${ORIGIN}/api/connections/1/previews${init.query ?? ""}`, { method, headers });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe("who may", () => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, list, start, stop } = stub();
    for (const method of ["GET", "POST", "DELETE"]) expect((await handlePreviews(call(method), null, deps, "1")).status, method).toBe(401);
    expect([list, start, stop].every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it("a write only from this site; a read needs no Origin", async () => {
    const { deps, start, stop, list } = stub();
    for (const method of ["POST", "DELETE"]) {
      for (const origin of ["https://evil.example", "null", null]) expect((await handlePreviews(call(method, { origin, query: "?branch=x" }), ALICE, deps, "1")).status, `${method} ${String(origin)}`).toBe(403);
    }
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect((await handlePreviews(call("GET", { origin: null }), ALICE, deps, "1")).status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("only the caller's own connection: another's, or one that is not there, is not found", async () => {
    const { deps } = stub();
    const missing: Deps = { ...deps, list: async () => ({ found: false }), start: async () => ({ found: false }), stop: async () => ({ found: false }) };
    for (const method of ["GET", "POST", "DELETE"]) expect((await handlePreviews(call(method, { query: "?branch=x" }), ALICE, missing, "1")).status, method).toBe(404);
    for (const id of ["abc", "0", "-1", "1.5", ""]) expect((await handlePreviews(call("GET"), ALICE, deps, id)).status, id).toBe(404);
    expect((await handlePreviews(call("PUT"), ALICE, deps, "1")).status).toBe(405);
  });
});

describe("what is sent, and what they are told", () => {
  it("lists the caller's previews and what a new one would hold", async () => {
    const { deps, list } = stub();
    const response = await handlePreviews(call("GET"), ALICE, deps, "1");
    expect(await body(response)).toEqual({ previews: [], pending: { files: ["content/posts/a.md"], skipped: [] }, max: 3 });
    expect(list.mock.calls).toEqual([["alice", 1]]);
  });

  it("starts a preview from nothing the request says: the branch, the paths and the text are the server's, and the caller is its author", async () => {
    const { deps, start } = stub();
    const response = await handlePreviews(new Request(`${ORIGIN}/api/connections/1/previews?branch=main&path=README.md`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ branch: "main", files: [{ path: "x", contents: "y" }] }) }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ branch: "fjord/preview/abc-20261102t220000z", files: ["content/posts/a.md"], skipped: [] });
    expect(start.mock.calls).toEqual([["alice", 1, { name: "Alice Example", email: "alice@example.com" }]]);
  });

  it("says why there is none, and names what was left out", async () => {
    const { deps } = stub();
    const nothing: Deps = { ...deps, start: async () => ({ found: true, result: { ok: false, reason: "nothing_to_preview", skipped: [{ path: "content/posts/a.md", reason: "changed_upstream" }] } }) };
    const response = await handlePreviews(call("POST"), ALICE, nothing, "1");
    expect(response.status).toBe(422);
    const answer = await body(response);
    expect(answer.error.code).toBe("nothing_to_preview");
    expect(answer.error.message).toContain("content/posts/a.md changed in the repository since you started editing it");
    for (const [reason, status] of [["too_many", 409], ["not_a_site", 422], ["read_only", 422], ["unavailable", 502]] as const) {
      const failing: Deps = { ...deps, start: async () => ({ found: true, result: { ok: false, reason } }) };
      expect((await handlePreviews(call("POST"), ALICE, failing, "1")).status, reason).toBe(status);
    }
  });

  it("stops one by its branch, and refuses to without one; a branch that is not the caller's is not found", async () => {
    const { deps, stop } = stub();
    expect((await handlePreviews(call("DELETE", { query: "?branch=fjord%2Fpreview%2Fabc-20261102t220000z" }), ALICE, deps, "1")).status).toBe(204);
    expect(stop.mock.calls).toEqual([["alice", 1, "fjord/preview/abc-20261102t220000z"]]);
    for (const query of ["", "?branch=", `?branch=${"x".repeat(201)}`]) expect((await handlePreviews(call("DELETE", { query }), ALICE, deps, "1")).status, query).toBe(400);
    const notMine: Deps = { ...deps, stop: async () => ({ found: true, result: { ok: false, reason: "not_yours" } }) };
    expect((await handlePreviews(call("DELETE", { query: "?branch=main" }), ALICE, notMine, "1")).status).toBe(404);
  });

  it("answers an unexpected failure plainly and describes nothing of it", async () => {
    const { deps } = stub();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken: Deps = { ...deps, list: async () => { throw new Error("secret github_pat_xyz"); } };
      const response = await handlePreviews(call("GET"), ALICE, broken, "1");
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("secret");
      const limited: Deps = { ...deps, list: async () => { throw new ProviderError("rate_limited", "slow down"); } };
      expect((await handlePreviews(call("GET"), ALICE, limited, "1")).status).toBe(429);
    } finally {
      error.mockRestore();
    }
  });
});
