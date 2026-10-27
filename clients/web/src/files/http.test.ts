import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Caller } from "../working/http";
import { type CreateResult, MAX_TITLE_CHARS, type VaultRefusal } from "./create";
import { type Deps, handleCreate } from "./http";

/**
 * Who may call `/api/connections/<id>/files`, from where, with what, and what they are told: the rules of `http.ts` with a
 * stand-in for what is behind it. Making the file against git is `create.test.ts`; whose it may be is `access.test.ts`; the
 * whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const valid = { vault: "Notes", folder: "Projects", kind: "note", title: "Plan", localMinute: WHEN };

function stub() {
  const create = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: CreateResult | { ok: false; reason: VaultRefusal } }> => ({
    found: true,
    result: { ok: true, path: "Notes/Projects/Plan.md", commit: "c".repeat(40) },
  }));
  const deps: Deps = { create: (accountId, id, input) => create(accountId, id, input), origin: ORIGIN };
  return { deps, create };
}

const post = (body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/files`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const body = async (response: Response) => JSON.parse(await response.text());

describe("who may", () => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, create } = stub();
    expect((await handleCreate(post(valid), null, deps, "1")).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("not from another site, even for a signed-in person", async () => {
    const { deps, create } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", `${ORIGIN}.evil.example`, "null", null]) {
      expect((await handleCreate(post(valid, { origin }), ALICE, deps, "1")).status).toBe(403);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("only POST", async () => {
    const { deps } = stub();
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await handleCreate(new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN } }), ALICE, deps, "1")).status).toBe(405);
    }
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, create } = stub();
    create.mockResolvedValue({ found: false });
    const response = await handleCreate(post(valid), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });

  it.each(["0", "01", "-1", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, create } = stub();
    expect((await handleCreate(post(valid), ALICE, deps, id)).status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("what may be sent", () => {
  it("is a place and a title, for the caller as their account names them, and never a name or a text", async () => {
    const { deps, create } = stub();
    const response = await handleCreate(post({ ...valid, name: "../../evil.md", path: "x", content: "evil", author: { name: "Mallory", email: "m@evil.example" } }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ path: "Notes/Projects/Plan.md", commit: "c".repeat(40) });
    expect(create).toHaveBeenCalledWith("alice", 1, {
      vault: "Notes",
      folder: "Projects",
      kind: "note",
      title: "Plan",
      localMinute: WHEN,
      author: { name: "Alice Example", email: "alice@example.com" },
    });
  });

  it("takes the top of a vault, a document, and no title", async () => {
    const { deps, create } = stub();
    expect((await handleCreate(post({ vault: "Notes", folder: "", kind: "document", title: "Q4 plan", localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect((await handleCreate(post({ vault: "Notes", folder: "", kind: "note", localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect((await handleCreate(post({ vault: "Notes", folder: "", kind: "note", title: null, localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect(create.mock.calls.map((call) => (call[2] as { title: string }).title)).toEqual(["Q4 plan", "", ""]);
  });

  it("wants JSON", async () => {
    const { deps, create } = stub();
    for (const type of ["text/plain", null]) expect((await handleCreate(post(valid, { type }), ALICE, deps, "1")).status).toBe(415);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no vault", { ...valid, vault: undefined }],
    ["a vault that is not text", { ...valid, vault: 5 }],
    ["a vault with a slash", { ...valid, vault: "Notes/Inner" }],
    ["a vault out of the repository", { ...valid, vault: ".." }],
    ["an empty vault", { ...valid, vault: "" }],
    ["no folder", { ...valid, folder: undefined }],
    ["a folder out of the vault", { ...valid, folder: "../Other" }],
    ["an absolute folder", { ...valid, folder: "/Projects" }],
    ["a folder with a backslash", { ...valid, folder: "Pro\\jects" }],
    ["no kind", { ...valid, kind: undefined }],
    ["a kind that is not one", { ...valid, kind: "folder" }],
    ["a title that is not text", { ...valid, title: 5 }],
    ["a title with a line break", { ...valid, title: "one\ntwo" }],
    ["a title with a NUL", { ...valid, title: "a\u0000b" }],
    ["a title with an unpaired surrogate", { ...valid, title: "a\ud800b" }],
    ["a title that is too long", { ...valid, title: "x".repeat(MAX_TITLE_CHARS + 1) }],
    ["no time", { ...valid, localMinute: undefined }],
    ["a time that is not a date", { ...valid, localMinute: { ...WHEN, month: 13 } }],
    ["a time with a fraction", { ...valid, localMinute: { ...WHEN, minute: 1.5 } }],
    ["a time in text", { ...valid, localMinute: { ...WHEN, hour: "14" } }],
    ["a year long ago", { ...valid, localMinute: { ...WHEN, year: 1969 } }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, create } = stub();
    expect((await handleCreate(post(sent), ALICE, deps, "1")).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("takes the longest title", async () => {
    const { deps } = stub();
    expect((await handleCreate(post({ ...valid, title: "x".repeat(MAX_TITLE_CHARS) }), ALICE, deps, "1")).status).toBe(201);
  });

  it("refuses a body that is far too large with 413", async () => {
    const { deps, create } = stub();
    expect((await handleCreate(post({ ...valid, extra: "y".repeat(20_000) }), ALICE, deps, "1")).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("what they are told", () => {
  it.each<[CreateResult extends infer R ? (R extends { ok: false; reason: infer X } ? X : never) : never, number]>([
    ["folder_gone", 409],
    ["bad_title", 422],
    ["head_moved", 409],
    ["read_only", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words", async (reason, status) => {
    const { deps, create } = stub();
    create.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleCreate(post(valid), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(20);
  });

  it.each<[VaultRefusal]>([["unknown_vault"], ["encrypted_vault"], ["unsupported_vault"]])("a vault that is %s is a 422 that says so", async (reason) => {
    const { deps, create } = stub();
    create.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleCreate(post(valid), ALICE, deps, "1");
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe(reason);
  });

  it("says when the instance cannot read repositories, and when the host is limiting", async () => {
    const { deps, create } = stub();
    create.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleCreate(post(valid), ALICE, deps, "1")).status).toBe(503);
    create.mockRejectedValueOnce(new ProviderError("rate_limited", "slow down"));
    expect((await handleCreate(post(valid), ALICE, deps, "1")).status).toBe(429);
  });

  it("answers an unexpected failure plainly, and logs its name and not its text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, create } = stub();
    create.mockRejectedValue(new Error("token github_pat_SECRET at postgres://user:hunter2@db"));
    const response = await handleCreate(post(valid), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|hunter2/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/SECRET|hunter2/);
    logged.mockRestore();
  });
});
