import { describe, expect, it, vi } from "vitest";
import { type ManageDeps, type OpenDeps, handleSealedOpen, handleSealedShares } from "./http";

/** The rules of the sealed share routes (ROADMAP 2c.1): who may make, list and revoke a share, what may be kept, and what a link is told. */
const ORIGIN = "https://fjord.example.com";
const ALICE = { accountId: "alice", userId: "alice" };
const AGE = Buffer.from("age-encryption.org/v1\n-> X25519 abc\nbody").toString("base64");
const TOKEN = "T".repeat(43);

function stub() {
  const list = vi.fn<ManageDeps["list"]>(async () => ({ found: true, shares: [{ id: 3, connectionId: 1, path: "Secret/a.md.age", mode: "key", createdAt: 10 }] }));
  const create = vi.fn<ManageDeps["create"]>(async () => ({ found: true, result: { ok: true, token: TOKEN, record: { id: 4, connectionId: 1, path: "Secret/a.md.age", mode: "key", createdAt: 11 } } }));
  const revoke = vi.fn<ManageDeps["revoke"]>(async () => ({ found: true, revoked: true }));
  return { deps: { list, create, revoke, origin: ORIGIN } satisfies ManageDeps, list, create, revoke };
}
const valid = { path: "Secret/a.md.age", mode: "key", ciphertext: AGE };
const request = (method: string, query = "", body?: unknown, headers: Record<string, string | null> = {}) => {
  const h: Record<string, string> = {};
  if (headers.origin !== null) h.origin = headers.origin ?? ORIGIN;
  if (body !== undefined && headers["content-type"] !== null) h["content-type"] = headers["content-type"] ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/sealed-shares${query}`, { method, headers: h, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe("who may make, list and revoke", () => {
  it("nobody who is not signed in, and nothing is asked", async () => {
    const { deps, list, create, revoke } = stub();
    for (const call of [request("GET", "?path=a.age"), request("POST", "", valid), request("DELETE", "?share=3")]) expect((await handleSealedShares(call, null, deps, "1")).status).toBe(401);
    expect([list, create, revoke].map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("not a write from another site, even for the owner", async () => {
    const { deps, create, revoke } = stub();
    for (const origin of ["https://evil.example", "null", null]) {
      expect((await handleSealedShares(request("POST", "", valid, { origin }), ALICE, deps, "1")).status).toBe(403);
      expect((await handleSealedShares(request("DELETE", "?share=3", undefined, { origin }), ALICE, deps, "1")).status).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("not another account's connection: it is a 404 saying nothing else", async () => {
    const { deps, list, create, revoke } = stub();
    list.mockResolvedValueOnce({ found: false });
    create.mockResolvedValueOnce({ found: false });
    revoke.mockResolvedValueOnce({ found: false });
    for (const call of [request("GET", "?path=a.age"), request("POST", "", valid), request("DELETE", "?share=3")]) {
      const response = await handleSealedShares(call, { accountId: "mallory", userId: "mallory" }, deps, "1");
      expect([response.status, (await body(response)).error.code]).toEqual([404, "not_found"]);
    }
  });

  it("only GET, POST and DELETE, on a connection that is a number", async () => {
    const { deps } = stub();
    expect((await handleSealedShares(request("PUT"), ALICE, deps, "1")).status).toBe(405);
    expect((await handleSealedShares(request("GET", "?path=a.age"), ALICE, deps, "1/../2")).status).toBe(404);
  });
});

describe("what is kept", () => {
  it("is the sealed copy, as sent, for the file and the mode named, and the answer holds the token once", async () => {
    const { deps, create } = stub();
    const response = await handleSealedShares(request("POST", "", valid), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ token: TOKEN, share: { id: 4, mode: "key", createdAt: 11 } });
    expect(create).toHaveBeenCalledWith("alice", 1, valid);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["plain text", Buffer.from("# My secret\n").toString("base64")],
    ["text that is not base64", "# My secret"],
    ["nothing", ""],
    ["a number", 5],
  ])("never keeps %s as a sealed copy", async (_name, ciphertext) => {
    const { deps, create } = stub();
    const response = await handleSealedShares(request("POST", "", { ...valid, ciphertext }), ALICE, deps, "1");
    expect(response.status).toBe(typeof ciphertext === "number" ? 400 : 422);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["a mode that is neither", { mode: "public" }],
    ["no mode", { mode: undefined }],
    ["a path with a way up", { path: "../x.age" }],
    ["no path", { path: undefined }],
  ])("refuses %s", async (_name, over) => {
    const { deps, create } = stub();
    expect((await handleSealedShares(request("POST", "", { ...valid, ...over }), ALICE, deps, "1")).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("wants JSON", async () => {
    const { deps, create } = stub();
    expect((await handleSealedShares(request("POST", "", JSON.stringify(valid), { "content-type": "text/plain" }), ALICE, deps, "1")).status).toBe(415);
    expect(create).not.toHaveBeenCalled();
  });

  it("says why a copy was not made, in words", async () => {
    for (const [reason, status] of [["not_encrypted", 422], ["too_many_for_file", 422], ["too_many", 422], ["unavailable", 502]] as const) {
      const { deps, create } = stub();
      create.mockResolvedValueOnce({ found: true, result: { ok: false, reason } });
      const response = await handleSealedShares(request("POST", "", valid), ALICE, deps, "1");
      expect([response.status, (await body(response)).error.code]).toEqual([status, reason]);
    }
  });

  it("does not put the copy in what it answers or logs when it fails unexpectedly", async () => {
    const { deps, create } = stub();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    create.mockRejectedValueOnce(new Error(`could not write ${AGE}`));
    const response = await handleSealedShares(request("POST", "", valid), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(AGE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(AGE);
    logged.mockRestore();
  });
});

describe("listing and revoking", () => {
  it("lists a file's shares by number, mode and time, and never a copy or a token", async () => {
    const { deps, list } = stub();
    const response = await handleSealedShares(request("GET", "?path=Secret%2Fa.md.age"), ALICE, deps, "1");
    expect(await body(response)).toEqual({ shares: [{ id: 3, mode: "key", createdAt: 10 }] });
    expect(list).toHaveBeenCalledWith("alice", 1, "Secret/a.md.age");
    expect((await handleSealedShares(request("GET"), ALICE, deps, "1")).status).toBe(400);
  });

  it("revokes by number, 204, and says when there is no such share", async () => {
    const { deps, revoke } = stub();
    expect((await handleSealedShares(request("DELETE", "?share=3"), ALICE, deps, "1")).status).toBe(204);
    expect(revoke).toHaveBeenCalledWith("alice", 1, 3);
    revoke.mockResolvedValueOnce({ found: true, revoked: false });
    expect((await handleSealedShares(request("DELETE", "?share=9"), ALICE, deps, "1")).status).toBe(404);
    for (const share of ["", "x", "0", "-1", "1.5"]) expect((await handleSealedShares(request("DELETE", `?share=${share}`), ALICE, deps, "1")).status, share).toBe(400);
  });
});

describe("a link opening its copy", () => {
  const open = (deps: OpenDeps, method = "GET") => handleSealedOpen(new Request(`${ORIGIN}/api/sealed/${TOKEN}`, { method }), deps, TOKEN);

  it("is given the copy and how it is sealed, with no session, and told not to keep it", async () => {
    const read = vi.fn<OpenDeps["read"]>(async () => ({ mode: "password", ciphertext: AGE, createdAt: 5 }));
    const response = await open({ read });
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ mode: "password", ciphertext: AGE, createdAt: 5 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledWith(TOKEN);
  });

  it("is told the same 404 for a token that is wrong, never was, or was revoked, and only GET is answered", async () => {
    const response = await open({ read: async () => undefined });
    expect([response.status, (await body(response)).error.code]).toEqual([404, "not_found"]);
    expect((await open({ read: async () => undefined }, "POST")).status).toBe(405);
  });

  it("does not put the copy in what it answers or logs when it fails unexpectedly", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await open({ read: async () => Promise.reject(new Error(`boom ${AGE} ${TOKEN}`)) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(AGE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(AGE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);
    logged.mockRestore();
  });
});
