import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { type Caller, type Deps, handleConnection, handleConnections, handleDefault, handleVault } from "./http";
import { ConnectionError } from "./errors";

/**
 * Who may call `/api/connections`, from where, and what they are told (DESIGN.md §12): the rules
 * of `http.ts`, with a stand-in service, so each is tested on its own. The service itself, on
 * real databases, is `service.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice" };
const TOKEN = "github_pat_secrettoken0123456789abcdefghijklmnopqrstuv";

function stub(overrides: Partial<Awaited<ReturnType<Deps["service"]>>> = {}) {
  const calls: unknown[][] = [];
  const service = {
    list: vi.fn(async (...args: unknown[]) => (calls.push(["list", ...args]), [])),
    addWithToken: vi.fn(async (...args: unknown[]) => {
      calls.push(["add", ...args]);
      return { connection: { id: 1, provider: "github" as const, kind: "pat" as const, owner: "acme", name: "notes", branch: "main", createdAt: 1 }, warnings: ["broad"] };
    }),
    remove: vi.fn(async (...args: unknown[]) => (calls.push(["remove", ...args]), true)),
    setDefault: vi.fn(async (...args: unknown[]) => (calls.push(["setDefault", ...args]), true)),
    setDefaultVault: vi.fn(async (...args: unknown[]) => (calls.push(["setDefaultVault", ...args]), true)),
    ...overrides,
  };
  const vaults = vi.fn(async (...args: unknown[]) => (calls.push(["vaults", ...args]), { found: true as const, vaults: ["Private", "Public"] as string[] | null }));
  const deps: Deps = { service: async () => service as never, origin: ORIGIN, vaults: (accountId, id) => vaults(accountId, id) };
  return { service, deps, calls, vaults };
}

const request = (method: string, init: { origin?: string | null; body?: unknown; type?: string | null; path?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}${init.path ?? "/api/connections"}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
};

const body = async (response: Response) => JSON.parse(await response.text());

describe("who may call", () => {
  it("nobody who is not signed in: 401 for every method, and the service is never asked", async () => {
    const { deps, service } = stub();
    expect((await handleConnections(request("GET"), null, deps)).status).toBe(401);
    expect((await handleConnections(request("POST", { body: { repository: "a/b", token: TOKEN } }), null, deps)).status).toBe(401);
    expect((await handleConnection(request("DELETE", { path: "/api/connections/1" }), null, deps, "1")).status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.addWithToken).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("refuses a write that does not come from this site, even from a signed-in person", async () => {
    const { deps, service } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", `${ORIGIN}.evil.example`, "null", null]) {
      const post = await handleConnections(request("POST", { origin, body: { repository: "a/b", token: TOKEN } }), ALICE, deps);
      expect(post.status, String(origin)).toBe(403);
      const del = await handleConnection(request("DELETE", { origin, path: "/api/connections/1" }), ALICE, deps, "1");
      expect(del.status, String(origin)).toBe(403);
    }
    expect(service.addWithToken).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("lets a signed-in person read their own list, for the caller's account only", async () => {
    const { deps, calls } = stub();
    const response = await handleConnections(request("GET", { origin: null, type: null }), ALICE, deps);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ connections: [] });
    expect(calls).toEqual([["list", "alice"]]);
  });

  it("acts for the caller's account and never one named in the request", async () => {
    const { deps, calls } = stub();
    await handleConnections(request("POST", { body: { repository: "acme/notes", token: TOKEN, accountId: "bob" } }), ALICE, deps);
    expect(calls).toEqual([["add", "alice", { repository: "acme/notes", token: TOKEN }]]);
  });

  it("answers a connection that is someone else's, or is not there, as not found", async () => {
    const { deps } = stub({ remove: async () => false });
    const response = await handleConnection(request("DELETE", { path: "/api/connections/9" }), ALICE, deps, "9");
    expect(response.status).toBe(404);
  });
});

describe("what it accepts", () => {
  it("connects with a token, answering 201 with the connection and no trace of the token", async () => {
    const { deps } = stub();
    const response = await handleConnections(request("POST", { body: { repository: "acme/notes", token: TOKEN } }), ALICE, deps);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({ connection: { owner: "acme", name: "notes" }, warnings: ["broad"] });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("disconnects with 204", async () => {
    const { deps, calls } = stub();
    const response = await handleConnection(request("DELETE", { path: "/api/connections/4" }), ALICE, deps, "4");
    expect(response.status).toBe(204);
    expect(calls).toEqual([["remove", "alice", 4]]);
  });

  it("is particular about how it is asked", async () => {
    const { deps, service } = stub();
    expect((await handleConnections(request("POST", { type: "text/plain", body: "x" }), ALICE, deps)).status).toBe(415);
    expect((await handleConnections(request("POST", { body: "{not json" }), ALICE, deps)).status).toBe(400);
    expect((await handleConnections(request("POST", { body: "[1,2]" }), ALICE, deps)).status).toBe(400);
    expect((await handleConnections(request("POST", { body: { repository: "a/b" } }), ALICE, deps)).status).toBe(400);
    expect((await handleConnections(request("POST", { body: { repository: 1, token: 2 } }), ALICE, deps)).status).toBe(400);
    expect((await handleConnections(request("POST", { body: { repository: "a/b", token: "x".repeat(20_000) } }), ALICE, deps)).status).toBe(413);
    expect((await handleConnections(request("PUT", { body: {} }), ALICE, deps)).status).toBe(405);
    expect((await handleConnection(request("GET", { path: "/api/connections/1" }), ALICE, deps, "1")).status).toBe(405);
    for (const id of ["abc", "-1", "0", "1.5", "99999999999999999999", ""]) {
      expect((await handleConnection(request("DELETE", { path: "/api/connections/x" }), ALICE, deps, id)).status, id).toBe(404);
    }
    expect(service.addWithToken).not.toHaveBeenCalled();
  });
});

describe("what it says when something goes wrong", () => {
  it.each([
    ["read_only", 422],
    ["bad_token", 422],
    ["not_found", 422],
    ["invalid_repository", 422],
    ["already_connected", 409],
    ["rate_limited", 429],
    ["unavailable", 502],
  ] as const)("says %s as %i, with the code and the message", async (code, status) => {
    const { deps } = stub({
      addWithToken: async () => {
        throw new ConnectionError(code, `message for ${code}`);
      },
    });
    const response = await handleConnections(request("POST", { body: { repository: "a/b", token: TOKEN } }), ALICE, deps);
    expect(response.status).toBe(status);
    expect(await body(response)).toEqual({ error: { code, message: `message for ${code}` } });
  });

  it("says plainly that the instance has no key to store a token under", async () => {
    const { deps } = stub();
    const noKey: Deps = {
      ...deps,
      service: async () => {
        throw new CredentialError("no_key", "FJORD_ENCRYPTION_KEY is required");
      },
    };
    const response = await handleConnections(request("POST", { body: { repository: "a/b", token: TOKEN } }), ALICE, noKey);
    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: "not_configured", message: expect.stringContaining("FJORD_ENCRYPTION_KEY") });
  });

  it("answers an error nobody expected plainly, and neither says nor logs what it was about", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { deps } = stub({
        addWithToken: async () => {
          throw new Error(`could not insert credential ${TOKEN}`);
        },
      });
      const response = await handleConnections(request("POST", { body: { repository: "a/b", token: TOKEN } }), ALICE, deps);
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain(TOKEN);
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    } finally {
      log.mockRestore();
    }
  });
});

describe("choosing the default repository", () => {
  const post = (init: Parameters<typeof request>[1] = {}) => request("POST", { type: null, path: "/api/connections/3/default", ...init });

  it("is for a signed-in person, from this site, and for their own connection", async () => {
    const { deps, service, calls } = stub();
    expect((await handleDefault(post(), null, deps, "3")).status).toBe(401);
    expect((await handleDefault(post({ origin: "https://evil.example" }), ALICE, deps, "3")).status).toBe(403);
    expect((await handleDefault(post({ origin: null }), ALICE, deps, "3")).status).toBe(403);
    expect(service.setDefault).not.toHaveBeenCalled();

    const done = await handleDefault(post(), ALICE, deps, "3");
    expect(done.status).toBe(204);
    expect(calls).toEqual([["setDefault", "alice", 3]]);
  });

  it("answers another account's connection, or one that is not there, as not found", async () => {
    const { deps } = stub({ setDefault: async () => false });
    expect((await handleDefault(post(), ALICE, deps, "3")).status).toBe(404);
    for (const id of ["abc", "-1", "0", "1.5", ""]) expect((await handleDefault(post(), ALICE, deps, id)).status, id).toBe(404);
  });

  it("takes only POST", async () => {
    const { deps } = stub();
    expect((await handleDefault(request("GET", { path: "/api/connections/3/default" }), ALICE, deps, "3")).status).toBe(405);
    expect((await handleDefault(request("DELETE", { path: "/api/connections/3/default" }), ALICE, deps, "3")).status).toBe(405);
  });
});

describe("choosing the vault a repository opens on", () => {
  const put = (body: unknown = { vault: "Public" }, init: Parameters<typeof request>[1] = {}) =>
    request("PUT", { path: "/api/connections/3/vault", body, ...init });

  it("is for a signed-in person, from this site, and for their own connection; the host is never asked before that", async () => {
    const { deps, service, vaults } = stub();
    expect((await handleVault(put(), null, deps, "3")).status).toBe(401);
    for (const origin of ["https://evil.example", "null", null]) {
      expect((await handleVault(put(undefined, { origin }), ALICE, deps, "3")).status, String(origin)).toBe(403);
    }
    expect(vaults).not.toHaveBeenCalled();
    expect(service.setDefaultVault).not.toHaveBeenCalled();
  });

  it("stores a vault the repository has, for the caller's account and the connection in the address", async () => {
    const { deps, calls } = stub();
    const done = await handleVault(put({ vault: "Public", accountId: "bob" }), ALICE, deps, "3");
    expect(done.status).toBe(204);
    expect(calls).toEqual([["vaults", "alice", 3], ["setDefaultVault", "alice", 3, "Public"]]);
  });

  it("refuses a vault the repository does not have, and stores nothing", async () => {
    const { deps, service } = stub();
    for (const vault of ["Nope", "public", "Public/", "../Public", " Public"]) {
      const response = await handleVault(put({ vault }), ALICE, deps, "3");
      expect(response.status, vault).toBe(422);
      expect((await body(response)).error.code).toBe("unknown_vault");
    }
    expect(service.setDefaultVault).not.toHaveBeenCalled();
  });

  it("answers another account's connection, or one that is not there, as not found, and stores nothing", async () => {
    const setDefaultVault = vi.fn(async () => false);
    const { deps } = stub({ setDefaultVault });
    const missing = { ...deps, vaults: async () => ({ found: false as const }) };
    expect((await handleVault(put(), ALICE, missing, "3")).status).toBe(404);
    expect(setDefaultVault).not.toHaveBeenCalled();
    // Forgetting a choice goes straight to the service, which answers for a connection that is not theirs.
    expect((await handleVault(put({ vault: null }), ALICE, deps, "3")).status).toBe(404);
    setDefaultVault.mockClear();
    for (const id of ["abc", "-1", "0", "1.5", ""]) expect((await handleVault(put(), ALICE, deps, id)).status, id).toBe(404);
    expect(setDefaultVault).not.toHaveBeenCalled();
  });

  it("forgets the choice with null, which needs no look at the repository", async () => {
    const { deps, calls, vaults } = stub();
    expect((await handleVault(put({ vault: null }), ALICE, deps, "3")).status).toBe(204);
    expect(vaults).not.toHaveBeenCalled();
    expect(calls).toEqual([["setDefaultVault", "alice", 3, null]]);
  });

  it("says so when the repository cannot be read just now, and stores nothing", async () => {
    const { deps, service } = stub();
    const down = { ...deps, vaults: async () => ({ found: true as const, vaults: null }) };
    expect((await handleVault(put(), ALICE, down, "3")).status).toBe(502);
    expect(service.setDefaultVault).not.toHaveBeenCalled();
  });

  it("takes only JSON of the right shape, and only PUT", async () => {
    const { deps, service } = stub();
    for (const bad of [{}, { vault: 3 }, { vault: "" }, { vault: "x".repeat(256) }, { vault: ["Public"] }, "[]", "nope"]) {
      expect((await handleVault(put(bad), ALICE, deps, "3")).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await handleVault(put({ vault: "Public" }, { type: "text/plain" }), ALICE, deps, "3")).status).toBe(415);
    for (const method of ["GET", "POST", "DELETE"]) expect((await handleVault(request(method, { path: "/api/connections/3/vault" }), ALICE, deps, "3")).status, method).toBe(405);
    expect(service.setDefaultVault).not.toHaveBeenCalled();
  });
});
