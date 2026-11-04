import { describe, expect, it, vi } from "vitest";
import { ConnectionError } from "../connections/errors";
import type { Caller } from "../connections/http";
import { type LocalDeps, handleLocalRepositories, handleSync } from "./http";
import { DEFAULT_LOCAL_LIMITS } from "./limits";

/**
 * Who may call `/api/connections/local` and `/api/connections/[id]/sync`, from where, and what they are told (DESIGN.md §12): the rules of
 * `http.ts` with a stand-in for what makes and moves a repository, each seen to fail with the rule switched off. What the move does is `sync.test.ts`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice" };
const TOKEN = "github_pat_secrettoken0123456789abcdefghijklmnopqrstuv";
const USAGE = { repositories: 1, files: 4, bytes: 100, limits: DEFAULT_LOCAL_LIMITS };

function stub(overrides: Partial<LocalDeps> = {}) {
  const create = vi.fn(async (_account: string, input: { name: string; kind: "drive" | "journal" }) => ({ id: 7, address: "drive/abcd2345", name: input.name }) as never);
  const usage = vi.fn(async (_account: string) => USAGE);
  const sync = vi.fn(async (_account: string, _id: number, _input: { repository: string; token: string }) => ({ connection: { id: 7, provider: "github" }, commit: "c0ffee", added: 3, already: 0 }) as never);
  const deps: LocalDeps = { origin: ORIGIN, create, usage, sync, ...overrides };
  return { deps, create, usage, sync };
}

const request = (method: string, init: { origin?: string | null; body?: unknown; type?: string | null; path?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}${init.path ?? "/api/connections/local"}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
  });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe("who may call", () => {
  it("nobody who is not signed in: 401, before anything is read or made", async () => {
    const { deps, create, usage, sync } = stub();
    expect((await handleLocalRepositories(request("GET"), null, deps)).status).toBe(401);
    expect((await handleLocalRepositories(request("POST", { body: { name: "Notes", kind: "drive" } }), null, deps)).status).toBe(401);
    expect((await handleSync(request("POST", { body: { repository: "a/b", token: TOKEN } }), null, deps, "7")).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("refuses a write that does not come from this site, even from a signed-in person", async () => {
    const { deps, create, sync } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", `${ORIGIN}.evil.example`, "null", null]) {
      expect((await handleLocalRepositories(request("POST", { origin, body: { name: "Notes", kind: "drive" } }), ALICE, deps)).status, String(origin)).toBe(403);
      expect((await handleSync(request("POST", { origin, body: { repository: "a/b", token: TOKEN } }), ALICE, deps, "7")).status, String(origin)).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("acts for the signed-in account and never one named in the request", async () => {
    const { deps, create, usage, sync } = stub();
    await handleLocalRepositories(request("GET"), ALICE, deps);
    await handleLocalRepositories(request("POST", { body: { name: "Notes", kind: "journal", accountId: "mallory" } }), ALICE, deps);
    await handleSync(request("POST", { body: { repository: "a/b", token: TOKEN, accountId: "mallory" } }), ALICE, deps, "7");
    expect(usage).toHaveBeenCalledWith("alice");
    expect(create).toHaveBeenCalledWith("alice", { name: "Notes", kind: "journal" });
    expect(sync).toHaveBeenCalledWith("alice", 7, { repository: "a/b", token: TOKEN });
  });

  it("is 404 for a repository that is not the caller's, as if it were not there", async () => {
    const { deps } = stub({ sync: async () => undefined });
    const response = await handleSync(request("POST", { body: { repository: "a/b", token: TOKEN } }), ALICE, deps, "7");
    expect(response.status).toBe(404);
    expect((await body(response)).error.code).toBe("not_found");
  });

  it("is 404 for an id that is not a number, without asking anyone", async () => {
    const { deps, sync } = stub();
    for (const id of ["abc", "0", "-1", "1.5", "1e3", "7/../8", ""]) expect((await handleSync(request("POST", { body: { repository: "a/b", token: TOKEN } }), ALICE, deps, id)).status, id).toBe(404);
    expect(sync).not.toHaveBeenCalled();
  });

  it("allows only the methods it has", async () => {
    const { deps } = stub();
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await handleLocalRepositories(request(method), ALICE, deps)).status, method).toBe(405);
    for (const method of ["GET", "PUT", "DELETE"]) expect((await handleSync(request(method), ALICE, deps, "7")).status, method).toBe(405);
  });
});

describe("what it takes", () => {
  it("says how much is used and what the limits are", async () => {
    const { deps } = stub();
    const response = await handleLocalRepositories(request("GET"), ALICE, deps);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ usage: USAGE });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("creates with a name and a kind of drive or journal, and answers 201", async () => {
    const { deps } = stub();
    const response = await handleLocalRepositories(request("POST", { body: { name: "Notes", kind: "drive" } }), ALICE, deps);
    expect(response.status).toBe(201);
    expect((await body(response)).connection).toMatchObject({ id: 7, address: "drive/abcd2345" });
  });

  it("refuses what is not JSON, not an object, or not the right shape, and makes nothing", async () => {
    const { deps, create, sync } = stub();
    expect((await handleLocalRepositories(request("POST", { type: "text/plain", body: "{}" }), ALICE, deps)).status).toBe(415);
    expect((await handleLocalRepositories(request("POST", { body: "[1]" }), ALICE, deps)).status).toBe(400);
    expect((await handleLocalRepositories(request("POST", { body: "not json" }), ALICE, deps)).status).toBe(400);
    for (const bad of [{ kind: "drive" }, { name: 5, kind: "drive" }, { name: "x", kind: "ssg" }, { name: "x" }, { name: "x".repeat(300), kind: "drive" }]) {
      expect((await handleLocalRepositories(request("POST", { body: bad }), ALICE, deps)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await handleSync(request("POST", { body: { repository: "a/b" } }), ALICE, deps, "7")).status).toBe(400);
    expect((await handleSync(request("POST", { body: { repository: 1, token: 2 } }), ALICE, deps, "7")).status).toBe(400);
    expect((await handleSync(request("POST", { type: "text/plain", body: "{}" }), ALICE, deps, "7")).status).toBe(415);
    expect(create).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe("what a person is told", () => {
  it("is the limit that was reached, in words that say what to do, and 409", async () => {
    const { deps } = stub({
      create: async () => {
        throw new ConnectionError("limit_reached", "You can keep 3 repositories on this server, and you have that many.");
      },
    });
    const response = await handleLocalRepositories(request("POST", { body: { name: "Notes", kind: "drive" } }), ALICE, deps);
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: { code: "limit_reached", message: "You can keep 3 repositories on this server, and you have that many." } });
  });

  it("is a name that cannot be used, 422", async () => {
    const { deps } = stub({
      create: async () => {
        throw new ConnectionError("invalid_name", "Give the repository a name.");
      },
    });
    expect((await handleLocalRepositories(request("POST", { body: { name: " ", kind: "drive" } }), ALICE, deps)).status).toBe(422);
  });

  it("names what a sync would overwrite, 409, and the answer to a success says what was added", async () => {
    const clash = stub({
      sync: async () => {
        throw new ConnectionError("would_overwrite", "acme/notes already has a file where these would go: a.md.");
      },
    });
    const refusal = await handleSync(request("POST", { body: { repository: "acme/notes", token: TOKEN } }), ALICE, clash.deps, "7");
    expect(refusal.status).toBe(409);
    expect((await body(refusal)).error.code).toBe("would_overwrite");
    const done = await handleSync(request("POST", { body: { repository: "acme/notes", token: TOKEN } }), ALICE, stub().deps, "7");
    expect(done.status).toBe(200);
    expect(await body(done)).toMatchObject({ commit: "c0ffee", added: 3, already: 0 });
  });

  it("never has the token in an answer, a success or a failure, and logs nothing of an unexpected error but its name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ok = await handleSync(request("POST", { body: { repository: "acme/notes", token: TOKEN } }), ALICE, stub().deps, "7");
      expect(await ok.text()).not.toContain(TOKEN);
      const broken = stub({
        sync: async () => {
          throw new Error(`boom with ${TOKEN}`);
        },
      });
      const failed = await handleSync(request("POST", { body: { repository: "acme/notes", token: TOKEN } }), ALICE, broken.deps, "7");
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain(TOKEN);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
    }
  });
});
