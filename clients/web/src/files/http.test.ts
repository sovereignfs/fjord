import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Caller } from "../working/http";
import { type CreateResult, MAX_TITLE_CHARS, type VaultRefusal } from "./create";
import type { DeleteResult } from "./delete";
import { type Deps, handleCreate, handleCreateEncrypted, handleDelete, handleEntry, handleIdentify, handleConvert, handlePost, handleTransfer, handleHeader, handleMove, handleRestore } from "./http";
import type { MoveResult } from "./move";
import type { RestoreResult } from "./restore";

/**
 * Who may call `/api/connections/<id>/files`, from where, with what, and what they are told: the rules of `http.ts` with a
 * stand-in for what is behind it. Making the file against git is `create.test.ts`; whose it may be is `access.test.ts`; the
 * whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };
const WHEN = { year: 2026, month: 10, day: 22, hour: 14, minute: 30 };
const valid = { vault: "Notes", folder: "Projects", title: "Plan", localMinute: WHEN };

function stub() {
  const create = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: CreateResult | { ok: false; reason: VaultRefusal } }> => ({
    found: true,
    result: { ok: true, path: "Notes/Projects/Plan.md", commit: "c".repeat(40) },
  }));
  const remove = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: DeleteResult | { ok: false; reason: VaultRefusal } }> => ({
    found: true,
    result: { ok: true, commit: "d".repeat(40), files: 1, deletions: [7] },
  }));
  const restore = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: RestoreResult }> => ({ found: true, result: { ok: true, commit: "e".repeat(40), paths: ["Notes/Plan.md"] } }));
  const move = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: MoveResult | { ok: false; reason: VaultRefusal; where: "source" | "destination" } }> => ({
    found: true,
    result: { ok: true, commit: "f".repeat(40), files: 1, moved: [{ from: "Notes/Plan.md", to: "Notes/Plans/Plan.md" }] },
  }));
  const entry = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; path: string; commit: string; date: string } | { ok: false; reason: "not_a_journal" | "encrypted_journal" | "bad_date" } }> => ({
    found: true,
    result: { ok: true, path: "journal/2026/11/02/0100.md", commit: "c".repeat(40), date: "2026-11-02T01:00:00+05:30" },
  }));
  const post = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; path: string; commit: string; date: string } | { ok: false; reason: "not_a_site" | "unknown_engine" | "bad_date" } }> => ({
    found: true,
    result: { ok: true, path: "content/_posts/2026-11-02-hello.md", commit: "c".repeat(40), date: "2026-11-02T01:00:00+05:30" },
  }));
  const header = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; header: string } | { ok: false; reason: "unreadable" | "bad_date" } | { ok: false; reason: "bad_tag"; message: string } }> => ({
    found: true,
    result: { ok: true, header: "---\ntitle: New\n---\n" },
  }));
  const createEncrypted = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; path: string; commit: string } | { ok: false; reason: string } }> => ({
    found: true,
    result: { ok: true, path: "Secret/Plan.md.age", commit: "c".repeat(40) },
  }));
  const convert = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; commit: string; files: never[] } | { ok: false; reason: "missing_files"; paths?: string[] } }> => ({
    found: true,
    result: { ok: true, commit: "e".repeat(40), files: [] },
  }));
  const transfer = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; commit: string; path: string } | { ok: false; reason: string } }> => ({
    found: true,
    result: { ok: true, commit: "c".repeat(40), path: "Locked/Plan.md.age" },
  }));
  const identify = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; docId: string; commit: string | null } | { ok: false; reason: string } }> => ({
    found: true,
    result: { ok: true, docId: "01jagc4k7pt8y3wqnmzv5xrb8j", commit: "a".repeat(40) },
  }));
  const deps: Deps = {
    identify: (accountId, id, input) => identify(accountId, id, input) as ReturnType<Deps["identify"]>,
    transfer: (accountId, id, input) => transfer(accountId, id, input) as ReturnType<Deps["transfer"]>,
    convert: (accountId, id, input) => convert(accountId, id, input) as ReturnType<Deps["convert"]>,
    snapshot: async () => ({ found: true as const, result: { ok: true as const, encrypted: false, naming: "plain" as const, files: [] } }),
    createEncrypted: (accountId, id, input) => createEncrypted(accountId, id, input) as ReturnType<Deps["createEncrypted"]>,
    header: (accountId, id, input) => header(accountId, id, input),
    entry: (accountId, id, input) => entry(accountId, id, input) as ReturnType<Deps["entry"]>,
    post: (accountId, id, input) => post(accountId, id, input) as ReturnType<Deps["post"]>,
    move: (accountId, id, input) => move(accountId, id, input),
    create: (accountId, id, input) => create(accountId, id, input),
    delete: (accountId, id, input) => remove(accountId, id, input),
    restore: (accountId, id, input) => restore(accountId, id, input),
    origin: ORIGIN,
  };
  return { deps, identify, create, createEncrypted, transfer, convert, remove, restore, header, move, entry, post };
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
     
      title: "Plan",
      localMinute: WHEN,
      author: { name: "Alice Example", email: "alice@example.com" },
    });
  });

  it("takes the top of a vault, a document, and no title", async () => {
    const { deps, create } = stub();
    expect((await handleCreate(post({ vault: "Notes", folder: "", title: "Q4 plan", localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect((await handleCreate(post({ vault: "Notes", folder: "", localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect((await handleCreate(post({ vault: "Notes", folder: "", title: null, localMinute: WHEN }), ALICE, deps, "1")).status).toBe(201);
    expect(create.mock.calls.map((call) => (call[2] as { title: string }).title)).toEqual(["Q4 plan", "", ""]);
  });

  it("passes on that a folder is a new one, only when it says so with true, and never for the top of a vault", async () => {
    const { deps, create, createEncrypted } = stub();
    expect((await handleCreate(post({ ...valid, folder: "Projects/Ideas", newFolder: true }), ALICE, deps, "1")).status).toBe(201);
    expect(create.mock.calls[0]?.[2]).toMatchObject({ folder: "Projects/Ideas", newFolder: true });
    expect((await handleCreate(post(valid), ALICE, deps, "1")).status).toBe(201);
    expect(create.mock.calls[1]?.[2]).not.toHaveProperty("newFolder");
    expect((await handleCreate(post({ ...valid, newFolder: "yes" }), ALICE, deps, "1")).status).toBe(400);
    expect((await handleCreate(post({ ...valid, folder: "", newFolder: true }), ALICE, deps, "1")).status).toBe(400);
    expect(create).toHaveBeenCalledTimes(2);
    void createEncrypted;
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
    ["a vault out of the repository", { ...valid, vault: ".." }],
    ["an empty vault", { ...valid, vault: "" }],
    ["no folder", { ...valid, folder: undefined }],
    ["a folder out of the vault", { ...valid, folder: "../Other" }],
    ["an absolute folder", { ...valid, folder: "/Projects" }],
    ["a folder with a backslash", { ...valid, folder: "Pro\\jects" }],
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
    ["folder_exists", 409],
    ["bad_folder_name", 422],
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

// --- Deleting and putting back (ROADMAP 1b.12) ---------------------------------------------------------------------

const BLOB = "a".repeat(40);
const delFile = { vault: "Notes", type: "file", path: "Notes/Plan.md", blob: BLOB };
const delFolder = { vault: "Notes", type: "folder", path: "Notes/Projects", files: 3 };
const at = (route: string, body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/files/${route}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};

describe.each([
  ["delete", handleDelete, delFile],
  ["restore", handleRestore, { ids: [7] }],
  ["move", handleMove, { ...delFile, destination: "Notes/Plans/Plan.md" }],
] as const)("%s: who may", (route, handler, good) => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, remove, restore, move } = stub();
    expect((await handler(at(route, good), null, deps, "1")).status).toBe(401);
    expect(remove).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("not from another site", async () => {
    const { deps, remove, restore, move } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) expect((await handler(at(route, good, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("only POST, and only JSON", async () => {
    const { deps } = stub();
    for (const method of ["GET", "PUT", "DELETE"]) expect((await handler(new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN } }), ALICE, deps, "1")).status).toBe(405);
    for (const type of ["text/plain", null]) expect((await handler(at(route, good, { type }), ALICE, deps, "1")).status).toBe(415);
  });

  it.each(["0", "01", "-1", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, remove, restore, move } = stub();
    expect((await handler(at(route, good), ALICE, deps, id)).status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, remove, restore, move } = stub();
    remove.mockResolvedValue({ found: false });
    restore.mockResolvedValue({ found: false });
    move.mockResolvedValue({ found: false });
    const response = await handler(at(route, good), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });

  it.each([["not JSON", "{nope"], ["an array", "[]"]])("refuses %s with 400", async (_name, sent) => {
    const { deps } = stub();
    expect((await handler(at(route, sent), ALICE, deps, "1")).status).toBe(400);
  });

  it("refuses a body that is far too large with 413", async () => {
    const { deps } = stub();
    expect((await handler(at(route, { ...good, extra: "y".repeat(20_000) }), ALICE, deps, "1")).status).toBe(413);
  });
});

describe("deleting: what may be sent, and what they are told", () => {
  it("is a place and what the person was shown, for the caller as their account names them", async () => {
    const { deps, remove } = stub();
    const response = await handleDelete(at("delete", { ...delFile, author: { name: "Mallory", email: "m@evil.example" } }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ commit: "d".repeat(40), files: 1, deletions: [7] });
    expect(remove).toHaveBeenCalledWith("alice", 1, { vault: "Notes", target: { type: "file", path: "Notes/Plan.md", blob: BLOB }, author: { name: "Alice Example", email: "alice@example.com" } });
    await handleDelete(at("delete", delFolder), ALICE, deps, "1");
    expect(remove).toHaveBeenLastCalledWith("alice", 1, expect.objectContaining({ target: { type: "folder", path: "Notes/Projects", files: 3 } }));
  });

  it.each([
    ["no vault", { ...delFile, vault: undefined }],
    ["no path", { ...delFile, path: undefined }],
    ["a path out of the repository", { ...delFile, path: "../x.md" }],
    ["no type", { ...delFile, type: undefined }],
    ["a type that is not one", { ...delFile, type: "vault" }],
    ["a file without the version shown", { vault: "Notes", type: "file", path: "Notes/Plan.md" }],
    ["a file with a version that is not an object id", { ...delFile, blob: "main" }],
    ["a file with a version in capitals", { ...delFile, blob: "A".repeat(40) }],
    ["a folder without a count", { vault: "Notes", type: "folder", path: "Notes/Projects" }],
    ["a folder with a count that is not a whole number", { ...delFolder, files: 1.5 }],
    ["a folder with a count of none", { ...delFolder, files: 0 }],
    ["a folder with a count in text", { ...delFolder, files: "3" }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, remove } = stub();
    expect((await handleDelete(at("delete", sent), ALICE, deps, "1")).status).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each<[Extract<DeleteResult, { ok: false }>["reason"], number]>([
    ["gone", 409],
    ["upstream_changed", 409],
    ["folder_changed", 409],
    ["too_many", 422],
    ["has_drafts", 409],
    ["draft_not_saved", 409],
    ["protected", 422],
    ["head_moved", 409],
    ["read_only", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words that say nothing was deleted", async (reason, status) => {
    const { deps, remove } = stub();
    remove.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleDelete(at("delete", delFile), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(20);
    expect(error.message).not.toMatch(/was made|nothing was made/i); // not the words for creating
  });

  it("says how many files, for a folder that holds others than the person was told, and for drafts", async () => {
    const { deps, remove } = stub();
    remove.mockResolvedValue({ found: true, result: { ok: false, reason: "folder_changed", detail: 4 } });
    const changed = await body(await handleDelete(at("delete", delFolder), ALICE, deps, "1"));
    expect(changed.error).toMatchObject({ code: "folder_changed", detail: 4 });
    expect(changed.error.message).toContain("4 files");
    remove.mockResolvedValue({ found: true, result: { ok: false, reason: "has_drafts", detail: 2 } });
    const drafts = await body(await handleDelete(at("delete", delFolder), ALICE, deps, "1"));
    expect(drafts.error.message).toMatch(/^2 of the files/);
  });

  it.each(["unknown_vault", "encrypted_vault", "unsupported_vault"] as const)("a vault that is %s is a 422 that says so", async (reason) => {
    const { deps, remove } = stub();
    remove.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleDelete(at("delete", delFile), ALICE, deps, "1");
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe(reason);
  });

  it("answers an unexpected failure plainly, and logs its name and not its text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, remove } = stub();
    remove.mockRejectedValue(new Error("token github_pat_SECRET at postgres://user:hunter2@db"));
    const response = await handleDelete(at("delete", delFile), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|hunter2/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/SECRET|hunter2/);
    logged.mockRestore();
  });
});

describe("putting back: what may be sent, and what they are told", () => {
  it("is deletions by number and, for one, a place; the caller is who is credited", async () => {
    const { deps, restore } = stub();
    const response = await handleRestore(at("restore", { ids: [7, 8, 8], path: null, author: { name: "Mallory", email: "m@evil.example" } }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ commit: "e".repeat(40), paths: ["Notes/Plan.md"] });
    expect(restore).toHaveBeenCalledWith("alice", 1, { ids: [7, 8, 8], path: undefined, author: { name: "Alice Example", email: "alice@example.com" } });
    await handleRestore(at("restore", { ids: [7], path: "Notes/Archive/Plan.md" }), ALICE, deps, "1");
    expect(restore).toHaveBeenLastCalledWith("alice", 1, expect.objectContaining({ ids: [7], path: "Notes/Archive/Plan.md" }));
  });

  it.each([
    ["no deletions", {}],
    ["none", { ids: [] }],
    ["a number that is not one", { ids: ["7"] }],
    ["a number that is not whole", { ids: [1.5] }],
    ["a number that is not positive", { ids: [0] }],
    ["a negative number", { ids: [-1] }],
    ["too many", { ids: Array.from({ length: 1001 }, (_, i) => i + 1) }],
    ["a place out of the repository", { ids: [7], path: "../x.md" }],
    ["a place that is not text", { ids: [7], path: 5 }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, restore } = stub();
    expect((await handleRestore(at("restore", sent), ALICE, deps, "1")).status).toBe(400);
    expect(restore).not.toHaveBeenCalled();
  });

  it.each<[Extract<RestoreResult, { ok: false }>["reason"], number]>([
    ["not_found", 404],
    ["already_restored", 409],
    ["expired", 409],
    ["bad_path", 422],
    ["vault_unavailable", 422],
    ["path_taken", 409],
    ["id_taken", 409],
    ["blob_gone", 422],
    ["head_moved", 409],
    ["read_only", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words", async (reason, status) => {
    const { deps, restore } = stub();
    restore.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleRestore(at("restore", { ids: [7] }), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(15);
  });

  it("names the paths that are taken", async () => {
    const { deps, restore } = stub();
    restore.mockResolvedValue({ found: true, result: { ok: false, reason: "path_taken", taken: ["Notes/a.md", "Notes/b.md"] } });
    expect((await body(await handleRestore(at("restore", { ids: [7, 8] }), ALICE, deps, "1"))).error.taken).toEqual(["Notes/a.md", "Notes/b.md"]);
  });
});

describe("setting a header's title", () => {
  const sent = { header: "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\n---\n", title: "New" };
  const call = (request: Request, caller: Caller | null, deps: Deps, id = "1") => handleHeader(request, caller, deps, id);
  const at = (body: unknown, init: { origin?: string | null; type?: string | null } = {}) => post(body, init);

  it("answers the header the module wrote, and asks for the caller's own connection with what was sent", async () => {
    const { deps, header } = stub();
    const response = await call(at(sent), ALICE, deps);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ header: "---\ntitle: New\n---\n" });
    expect(header).toHaveBeenCalledWith("alice", 1, sent);
  });

  it("is for someone signed in, from this site, by POST only: nothing is asked otherwise", async () => {
    const { deps, header } = stub();
    expect((await call(at(sent), null, deps)).status).toBe(401);
    for (const origin of [null, "https://evil.example.com", `${ORIGIN}.evil.example.com`]) expect((await call(at(sent, { origin }), ALICE, deps)).status).toBe(403);
    for (const method of ["GET", "PUT", "DELETE"]) expect((await call(new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN } }), ALICE, deps)).status).toBe(405);
    expect(header).not.toHaveBeenCalled();
  });

  it("is a 404 for another's connection or an id that is not one", async () => {
    const { deps, header } = stub();
    header.mockResolvedValueOnce({ found: false });
    expect((await call(at(sent), ALICE, deps)).status).toBe(404);
    for (const id of ["0", "01", "x", "-1", "1e3", "1".repeat(17)]) expect((await call(at(sent), ALICE, deps, id)).status).toBe(404);
    expect(header).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no header", { title: "x" }],
    ["a header that is not text", { header: 1, title: "x" }],
    ["no title", { header: "---\n---\n" }],
    ["a title that is not text", { header: "---\n---\n", title: null }],
    ["a title of two lines", { header: "---\n---\n", title: "a\nb" }],
    ["a title with a control character", { header: "---\n---\n", title: "a\u0007" }],
    ["a title that is too long", { header: "---\n---\n", title: "x".repeat(MAX_TITLE_CHARS + 1) }],
    ["a title with half a character", { header: "---\n---\n", title: "\ud800" }],
    ["a header that is too long", { header: "x".repeat(64_001), title: "x" }],
  ])("refuses %s, and asks nothing", async (_name, sentBody) => {
    const { deps, header } = stub();
    expect((await call(at(sentBody), ALICE, deps)).status).toBe(400);
    expect(header).not.toHaveBeenCalled();
  });

  it("refuses what is not JSON, and an empty title is fine (it takes the title away)", async () => {
    const { deps, header } = stub();
    expect((await call(at(sent, { type: "text/plain" }), ALICE, deps)).status).toBe(415);
    expect((await call(at("not json"), ALICE, deps)).status).toBe(400);
    expect((await call(at({ header: "---\n---\n", title: "" }), ALICE, deps)).status).toBe(200);
    expect(header).toHaveBeenCalledTimes(1);
  });

  it("says a header that cannot be read is not changed", async () => {
    const { deps, header } = stub();
    header.mockResolvedValueOnce({ found: true, result: { ok: false, reason: "unreadable" } });
    const response = await call(at(sent), ALICE, deps);
    expect(response.status).toBe(422);
    expect((await body(response)).error.code).toBe("unreadable_header");
  });

  it("tells a failure we did not expect plainly, without its message", async () => {
    const { deps, header } = stub();
    header.mockRejectedValueOnce(new Error("secret detail"));
    const response = await call(at(sent), ALICE, deps);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
  });
});

// --- Renaming and moving (ROADMAP 1b.11) ----------------------------------------------------------------------------------

describe("moving: what may be sent, and what they are told", () => {
  const mvFile = { ...delFile, destination: "Notes/Plans/Plan.md" };
  const mvFolder = { ...delFolder, destination: "Other/Projects" };

  it("is a place, what the person was shown and where it goes, for the caller as their account names them", async () => {
    const { deps, move } = stub();
    const response = await handleMove(at("move", { ...mvFile, author: { name: "Mallory", email: "m@evil.example" } }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ commit: "f".repeat(40), files: 1, moved: [{ from: "Notes/Plan.md", to: "Notes/Plans/Plan.md" }] });
    expect(move).toHaveBeenCalledWith("alice", 1, { vault: "Notes", target: { type: "file", path: "Notes/Plan.md", blob: BLOB }, destination: "Notes/Plans/Plan.md", author: { name: "Alice Example", email: "alice@example.com" } });
    await handleMove(at("move", mvFolder), ALICE, deps, "1");
    expect(move).toHaveBeenLastCalledWith("alice", 1, expect.objectContaining({ target: { type: "folder", path: "Notes/Projects", files: 3 }, destination: "Other/Projects" }));
  });

  it.each([
    ["no destination", { ...mvFile, destination: undefined }],
    ["a destination out of the repository", { ...mvFile, destination: "../x.md" }],
    ["a destination that is not text", { ...mvFile, destination: 7 }],
    ["a destination with a control character", { ...mvFile, destination: "Notes/a\u0007.md" }],
    ["a destination with half a character", { ...mvFile, destination: "Notes/\ud800.md" }],
    ["a destination that is too long", { ...mvFile, destination: `Notes/${"x".repeat(1000)}.md` }],
    ["no vault", { ...mvFile, vault: undefined }],
    ["a file without the version shown", { vault: "Notes", type: "file", path: "Notes/Plan.md", destination: "Notes/b.md" }],
    ["a folder without a count", { vault: "Notes", type: "folder", path: "Notes/Projects", destination: "Notes/b" }],
    ["a type that is not one", { ...mvFile, type: "vault" }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, move } = stub();
    expect((await handleMove(at("move", sent), ALICE, deps, "1")).status).toBe(400);
    expect(move).not.toHaveBeenCalled();
  });

  it.each<[Extract<MoveResult, { ok: false }>["reason"], number]>([
    ["gone", 409],
    ["upstream_changed", 409],
    ["folder_changed", 409],
    ["too_many", 422],
    ["has_drafts", 409],
    ["draft_not_saved", 409],
    ["protected", 422],
    ["bad_path", 422],
    ["extension_changed", 422],
    ["into_itself", 422],
    ["unchanged", 422],
    ["path_taken", 409],
    ["head_moved", 409],
    ["read_only", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words, and says nothing was moved", async (reason, status) => {
    const { deps, move } = stub();
    move.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleMove(at("move", mvFile), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(15);
  });

  it("names the paths that are in the way", async () => {
    const { deps, move } = stub();
    move.mockResolvedValue({ found: true, result: { ok: false, reason: "path_taken", taken: ["Notes/Plans/Plan.md"] } });
    expect((await body(await handleMove(at("move", mvFile), ALICE, deps, "1"))).error.taken).toEqual(["Notes/Plans/Plan.md"]);
  });

  it.each<[VaultRefusal, "source" | "destination"]>([
    ["unknown_vault", "destination"],
    ["encrypted_vault", "destination"],
    ["unsupported_vault", "destination"],
    ["encrypted_vault", "source"],
  ])("a vault that is %s (the %s) is a 422 that says which", async (reason, where) => {
    const { deps, move } = stub();
    move.mockResolvedValue({ found: true, result: { ok: false, reason, where } });
    const response = await handleMove(at("move", mvFile), ALICE, deps, "1");
    expect(response.status).toBe(422);
    const error = (await body(response)).error;
    expect(error.code).toBe(reason);
    if (where === "destination" && reason === "encrypted_vault") expect(error.message).toMatch(/into an encrypted vault/);
  });
});

describe("making a file in an encrypted vault (ROADMAP 2b.4)", () => {
  const AGE = Buffer.from("age-encryption.org/v1\n-> X25519 abc\nbody").toString("base64");
  const secret = { vault: "Secret", folder: "", title: "Plan", localMinute: WHEN, ciphertext: AGE };
  const send = (body: unknown, init?: Parameters<typeof post>[1]) => {
    const request = post(body, init);
    return new Request(request.url.replace("/files", "/files/encrypted"), { method: "POST", headers: request.headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  };

  it("hands the bytes to the repository's rules, decoded, with the title and the caller", async () => {
    const { deps, createEncrypted } = stub();
    const response = await handleCreateEncrypted(send(secret), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ path: "Secret/Plan.md.age", commit: "c".repeat(40) });
    const given = createEncrypted.mock.calls[0]![2] as { ciphertext: Uint8Array; title: string; author: unknown };
    expect(Buffer.from(given.ciphertext).toString()).toContain("age-encryption.org/v1");
    expect(given.title).toBe("Plan");
    expect(given.author).toEqual({ name: "Alice Example", email: "alice@example.com" });
  });

  it("is for nobody signed out, nor from another site, and asks nothing of the repository", async () => {
    const { deps, createEncrypted } = stub();
    expect((await handleCreateEncrypted(send(secret), null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", "null", null]) expect((await handleCreateEncrypted(send(secret, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect((await handleCreateEncrypted(send(secret, { type: "text/plain" }), ALICE, deps, "1")).status).toBe(415);
    expect(createEncrypted).not.toHaveBeenCalled();
  });

  it("is POST only, and for a connection that is a number", async () => {
    const { deps } = stub();
    expect((await handleCreateEncrypted(new Request(`${ORIGIN}/x`, { method: "GET" }), ALICE, deps, "1")).status).toBe(405);
    expect((await handleCreateEncrypted(send(secret), ALICE, deps, "1/../2")).status).toBe(404);
  });

  it.each([
    ["plain text", Buffer.from("# My secret\n").toString("base64")],
    ["text that is not base64", "# My secret"],
    ["nothing", ""],
    ["a number", 5],
    ["a file larger than a new one can be", Buffer.from(`age-encryption.org/v1\n${"x".repeat(70_000)}`).toString("base64")],
  ])("never commits %s as the file, and says that only an encrypted file goes in", async (_name, ciphertext) => {
    const { deps, createEncrypted } = stub();
    const response = await handleCreateEncrypted(send({ ...secret, ciphertext }), ALICE, deps, "1");
    expect(response.status).toBe(typeof ciphertext === "number" ? 400 : 422);
    expect(createEncrypted).not.toHaveBeenCalled();
  });

  it.each([
    ["no vault", { vault: undefined }],
    ["a way up in the folder", { folder: "../x" }],
    ["a title with a line break", { title: "a\nb" }],
    ["a title too long", { title: "x".repeat(MAX_TITLE_CHARS + 1) }],
    ["no date", { localMinute: undefined }],
  ])("refuses %s", async (_name, over) => {
    const { deps, createEncrypted } = stub();
    expect((await handleCreateEncrypted(send({ ...secret, ...over }), ALICE, deps, "1")).status).toBe(400);
    expect(createEncrypted).not.toHaveBeenCalled();
  });

  it("says why a vault was refused, in words, as 422", async () => {
    for (const reason of ["unknown_vault", "not_encrypted", "unsupported_vault", "wrong_shape", "folder_gone"]) {
      const { deps, createEncrypted } = stub();
      createEncrypted.mockResolvedValueOnce({ found: true, result: { ok: false, reason } });
      const response = await handleCreateEncrypted(send(secret), ALICE, deps, "1");
      expect([response.status, (await body(response)).error.code]).toEqual([reason === "folder_gone" ? 409 : 422, reason]);
    }
  });

  it("is a 404, saying nothing else, for a connection that is not the caller's", async () => {
    const { deps, createEncrypted } = stub();
    createEncrypted.mockResolvedValueOnce({ found: false });
    const response = await handleCreateEncrypted(send(secret), ALICE, deps, "1");
    expect([response.status, (await body(response)).error.code]).toEqual([404, "not_found"]);
  });

  it("never puts the file's contents or name in what it answers or logs when it fails unexpectedly", async () => {
    const { deps, createEncrypted } = stub();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createEncrypted.mockRejectedValueOnce(new Error(`could not write ${AGE}`));
    const response = await handleCreateEncrypted(send(secret), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(AGE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(AGE);
    logged.mockRestore();
  });
});

describe("moving a file between vaults, one of them encrypted (ROADMAP 2b.6)", () => {
  const BLOB = "a".repeat(40);
  const AGE = Buffer.from("age-encryption.org/v1\n-> X25519 abc\nbody").toString("base64");
  const valid = { path: "Notes/Plan.md", blob: BLOB, destination: "Locked/Plan.md.age", content: AGE };
  const send = (body: unknown, init?: Parameters<typeof post>[1]) => {
    const request = post(body, init);
    return new Request(request.url.replace("/files", "/files/transfer"), { method: "POST", headers: request.headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  };

  it("hands the repository's rules the path, the blob shown, the destination and the decoded bytes, with the caller", async () => {
    const { deps, transfer } = stub();
    const response = await handleTransfer(send(valid), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ commit: "c".repeat(40), path: "Locked/Plan.md.age" });
    const given = transfer.mock.calls[0]![2] as { content: Uint8Array; path: string; blob: string; destination: string };
    expect([given.path, given.blob, given.destination]).toEqual(["Notes/Plan.md", BLOB, "Locked/Plan.md.age"]);
    expect(Buffer.from(given.content).toString()).toContain("age-encryption.org/v1");
  });

  it("is for nobody signed out, nor from another site, nor a connection that is not a number, and asks nothing", async () => {
    const { deps, transfer } = stub();
    expect((await handleTransfer(send(valid), null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", "null", null]) expect((await handleTransfer(send(valid, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect((await handleTransfer(send(valid, { type: "text/plain" }), ALICE, deps, "1")).status).toBe(415);
    expect((await handleTransfer(send(valid), ALICE, deps, "1/../2")).status).toBe(404);
    expect((await handleTransfer(new Request(`${ORIGIN}/x`, { method: "GET" }), ALICE, deps, "1")).status).toBe(405);
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each([
    ["no path", { path: undefined }],
    ["a way up in the path", { path: "../x.md" }],
    ["a blob that is not an object id", { blob: "main" }],
    ["a destination with a way up", { destination: "Locked/../x.age" }],
    ["a destination with a control character", { destination: "Locked/a\u0001.age" }],
    ["content that is not base64", { content: "not base64!" }],
    ["content that is not text", { content: 5 }],
  ])("refuses %s", async (_name, over) => {
    const { deps, transfer } = stub();
    expect((await handleTransfer(send({ ...valid, ...over }), ALICE, deps, "1")).status).toBe(400);
    expect(transfer).not.toHaveBeenCalled();
  });

  it("says why, in words, with the right status", async () => {
    for (const [reason, status] of [["wrong_form", 422], ["path_taken", 409], ["upstream_changed", 409], ["has_drafts", 409], ["same_vault", 422], ["no_encryption", 422], ["unsupported_vault", 422], ["unavailable", 502]] as const) {
      const { deps, transfer } = stub();
      transfer.mockResolvedValueOnce({ found: true, result: { ok: false, reason } });
      const response = await handleTransfer(send(valid), ALICE, deps, "1");
      expect([response.status, (await body(response)).error.code]).toEqual([status, reason]);
    }
  });

  it("is a 404, saying nothing else, for a connection that is not the caller's", async () => {
    const { deps, transfer } = stub();
    transfer.mockResolvedValueOnce({ found: false });
    const response = await handleTransfer(send(valid), ALICE, deps, "1");
    expect([response.status, (await body(response)).error.code]).toEqual([404, "not_found"]);
  });

  it("does not put the file in what it answers or logs when it fails unexpectedly", async () => {
    const { deps, transfer } = stub();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    transfer.mockRejectedValueOnce(new Error(`could not write ${AGE}`));
    const response = await handleTransfer(send(valid), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(AGE);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(AGE);
    logged.mockRestore();
  });
});

describe("a journal entry, and a header's date and tags (ROADMAP 3b.1, 3b.3)", () => {
  const AT = 1_793_561_400_000;

  it("is for a signed-in person, from this site; nothing is asked before that", async () => {
    const { deps, entry } = stub();
    expect((await handleEntry(post({ at: AT, offsetMinutes: 330 }), null, deps, "1")).status).toBe(401);
    expect((await handleEntry(post({ at: AT, offsetMinutes: 330 }, { origin: "https://evil.example" }), ALICE, deps, "1")).status).toBe(403);
    expect((await handleEntry(post({ at: AT, offsetMinutes: 330 }), ALICE, deps, "x")).status).toBe(404);
    expect(entry).not.toHaveBeenCalled();
  });

  it("sends the moment and the writer's offset, and only those, with the caller as its author", async () => {
    const { deps, entry } = stub();
    const done = await handleEntry(post({ at: AT, offsetMinutes: 330, title: "Late", path: "elsewhere.md" }), ALICE, deps, "1");
    expect(done.status).toBe(201);
    expect(await body(done)).toEqual({ path: "journal/2026/11/02/0100.md", commit: "c".repeat(40), date: "2026-11-02T01:00:00+05:30" });
    expect(entry.mock.calls).toEqual([["alice", 1, { at: AT, offsetMinutes: 330, title: "Late", author: { name: "Alice Example", email: "alice@example.com" } }]]);
  });

  it("refuses a moment or an offset that is not one, and says when the repository is not a plaintext journal", async () => {
    const { deps, entry } = stub();
    for (const bad of [{}, { at: "now", offsetMinutes: 0 }, { at: -1, offsetMinutes: 0 }, { at: AT, offsetMinutes: 1440 }, { at: AT, offsetMinutes: 1.5 }, { at: AT, offsetMinutes: 0, title: "a\nb" }]) {
      expect((await handleEntry(post(bad), ALICE, deps, "1")).status, JSON.stringify(bad)).toBe(400);
    }
    expect(entry).not.toHaveBeenCalled();
    for (const reason of ["not_a_journal", "encrypted_journal"] as const) {
      const failing = { ...deps, entry: async () => ({ found: true as const, result: { ok: false as const, reason } }) };
      const response = await handleEntry(post({ at: AT, offsetMinutes: 0 }), ALICE, failing, "1");
      expect(response.status, reason).toBe(422);
      expect((await body(response)).error.code).toBe(reason);
    }
  });

  it("changes one key of a header at a time: a date (or none) and the tags, and says when a date is not one", async () => {
    const { deps, header } = stub();
    expect((await handleHeader(post({ header: "---\n", date: "2026-11-02" }), ALICE, deps, "1")).status).toBe(200);
    expect((await handleHeader(post({ header: "---\n", date: null }), ALICE, deps, "1")).status).toBe(200);
    expect((await handleHeader(post({ header: "---\n", tags: ["Work", "project/fjord"] }), ALICE, deps, "1")).status).toBe(200);
    expect(header.mock.calls.map((call) => call[2])).toEqual([
      { header: "---\n", date: "2026-11-02" },
      { header: "---\n", date: null },
      { header: "---\n", tags: ["Work", "project/fjord"] },
    ]);
    for (const bad of [{ header: "---\n" }, { header: "---\n", title: "x", date: "2026-11-02" }, { header: "---\n", tags: "Work" }, { header: "---\n", tags: [""] }, { header: "---\n", tags: ["a\nb"] }, { header: "---\n", date: 3 }]) {
      expect((await handleHeader(post(bad), ALICE, deps, "1")).status, JSON.stringify(bad)).toBe(400);
    }
    const refusing = { ...deps, header: async () => ({ found: true as const, result: { ok: false as const, reason: "bad_date" as const } }) };
    const refused = await handleHeader(post({ header: "---\n", date: "yesterday" }), ALICE, refusing, "1");
    expect(refused.status).toBe(422);
    expect((await body(refused)).error.code).toBe("bad_date");
  });
});

describe("a site's post, and a tag its engine would read as two (ROADMAP 3c.2)", () => {
  const AT = 1_793_561_400_000;

  it("is for a signed-in person, from this site; nothing is asked before that", async () => {
    const { deps, post } = stub();
    expect((await handlePost(post_(null), null, deps, "1")).status).toBe(401);
    expect((await handlePost(post_({ origin: "https://evil.example" }), ALICE, deps, "1")).status).toBe(403);
    expect((await handlePost(post_(), ALICE, deps, "x")).status).toBe(404);
    expect(post).not.toHaveBeenCalled();
    function post_(opts: { origin?: string } | null = {}) {
      return opts === null ? post0({ at: AT, offsetMinutes: 330 }) : post0({ at: AT, offsetMinutes: 330 }, opts.origin ? { origin: opts.origin } : {});
    }
  });

  it("sends the moment, the offset, the title and whether it is a draft, and only those, with the caller as its author", async () => {
    const { deps, post } = stub();
    const done = await handlePost(post0({ at: AT, offsetMinutes: 330, title: "Hello", draft: true, path: "elsewhere.md" }), ALICE, deps, "1");
    expect(done.status).toBe(201);
    expect(await body(done)).toEqual({ path: "content/_posts/2026-11-02-hello.md", commit: "c".repeat(40), date: "2026-11-02T01:00:00+05:30" });
    expect(post.mock.calls).toEqual([["alice", 1, { at: AT, offsetMinutes: 330, title: "Hello", draft: true, author: { name: "Alice Example", email: "alice@example.com" } }]]);
  });

  it("refuses what is not a moment, an offset or a draft flag, and says when the repository is not a site", async () => {
    const { deps, post } = stub();
    for (const bad of [{}, { at: "now", offsetMinutes: 0 }, { at: AT, offsetMinutes: 1440 }, { at: AT, offsetMinutes: 0, draft: "yes" }, { at: AT, offsetMinutes: 0, title: "a\nb" }]) {
      expect((await handlePost(post0(bad), ALICE, deps, "1")).status, JSON.stringify(bad)).toBe(400);
    }
    expect(post).not.toHaveBeenCalled();
    for (const reason of ["not_a_site", "unknown_engine"] as const) {
      const failing = { ...deps, post: async () => ({ found: true as const, result: { ok: false as const, reason } }) };
      const response = await handlePost(post0({ at: AT, offsetMinutes: 0 }), ALICE, failing, "1");
      expect(response.status, reason).toBe(422);
      expect((await body(response)).error.code).toBe(reason);
    }
  });

  it("answers a tag the engine would read as two with the words for it, not a bare failure", async () => {
    const { deps } = stub();
    const refusing = { ...deps, header: async () => ({ found: true as const, result: { ok: false as const, reason: "bad_tag" as const, message: "“two words”: Jekyll reads a tag with a space as two." } }) };
    const response = await handleHeader(post0({ header: "---\n", tags: ["two words"] }), ALICE, refusing, "1");
    expect(response.status).toBe(422);
    expect(await body(response)).toEqual({ error: { code: "bad_tag", message: "“two words”: Jekyll reads a tag with a space as two." } });
  });

  function post0(payload: unknown, init: { origin?: string | null; type?: string | null } = {}) {
    return post(payload, init);
  }
});


describe("giving a Doc an identifier (ROADMAP 3e.3)", () => {
  const ok = { path: "Notes/Plan.md", blob: "b".repeat(40) };

  it("is asked for by a signed-in person, from this site, with the file and the version they looked at, and answers with the id", async () => {
    const { deps, identify } = stub();
    const response = await handleIdentify(post(ok), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ docId: "01jagc4k7pt8y3wqnmzv5xrb8j", commit: "a".repeat(40) });
    expect(identify).toHaveBeenCalledWith("alice", 1, { ...ok, author: { name: "Alice Example", email: "alice@example.com" } });
  });

  it("is not for a person who is not signed in (401), another site (403), a method other than POST (405), or another's connection (404)", async () => {
    const { deps, identify } = stub();
    expect((await handleIdentify(post(ok), null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, null]) expect((await handleIdentify(post(ok, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect((await handleIdentify(new Request(`${ORIGIN}/x`, { method: "GET", headers: { origin: ORIGIN } }), ALICE, deps, "1")).status).toBe(405);
    expect(identify).not.toHaveBeenCalled();
    identify.mockResolvedValueOnce({ found: false });
    expect((await handleIdentify(post(ok), ALICE, deps, "1")).status).toBe(404);
  });

  it.each([
    ["no path", { ...ok, path: undefined }],
    ["a path at the top, which no vault can hold", { ...ok, path: "Plan.md" }],
    ["a path that climbs out", { ...ok, path: "Notes/../x.md" }],
    ["no version", { ...ok, blob: undefined }],
    ["a version that is not an object id", { ...ok, blob: "main" }],
    ["a version in capitals", { ...ok, blob: "B".repeat(40) }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, identify } = stub();
    expect((await handleIdentify(post(sent), ALICE, deps, "1")).status).toBe(400);
    expect(identify).not.toHaveBeenCalled();
  });

  it.each([
    ["gone", 409],
    ["changed", 409],
    ["not_markdown", 422],
    ["cannot_identify", 422],
    ["encrypted_vault", 422],
    ["head_moved", 409],
    ["read_only", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words", async (reason, status) => {
    const { deps, identify } = stub();
    identify.mockResolvedValueOnce({ found: true, result: { ok: false, reason } });
    const response = await handleIdentify(post(ok), ALICE, deps, "1");
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(reason);
  });
});

describe("setting one field of a header (RFC 0002)", () => {
  const HEADER = "---\nid: 01jagc4k7pt8y3wqnmzv5xrb8j\n---\n";
  const at = (body: unknown) => post(body);

  it("passes the field, as text, a yes or no, or null, with the header, and answers the header the module wrote", async () => {
    const { deps, header } = stub();
    for (const field of [{ key: "description", value: "A first post." }, { key: "draft", value: false }, { key: "layout", value: null }]) {
      const response = await handleHeader(at({ header: HEADER, field }), ALICE, deps, "1");
      expect(response.status, JSON.stringify(field)).toBe(200);
      expect(header).toHaveBeenLastCalledWith("alice", 1, { header: HEADER, field });
    }
  });

  it.each([
    ["a field and a title together", { header: HEADER, title: "x", field: { key: "draft", value: true } }],
    ["no key", { header: HEADER, field: { value: true } }],
    ["a key that is not a plain word", { header: HEADER, field: { key: "has space", value: "x" } }],
    ["a key with a colon", { header: HEADER, field: { key: "a:b", value: "x" } }],
    ["a key too long", { header: HEADER, field: { key: "k".repeat(65), value: "x" } }],
    ["the identifier", { header: HEADER, field: { key: "id", value: "x" } }],
    ["the day it was made", { header: HEADER, field: { key: "created", value: "x" } }],
    ["a client's own state", { header: HEADER, field: { key: "fjord", value: "x" } }],
    ["a list", { header: HEADER, field: { key: "draft", value: ["a"] } }],
    ["a number", { header: HEADER, field: { key: "draft", value: 7 } }],
    ["text with a line break", { header: HEADER, field: { key: "description", value: "a\nb" } }],
    ["text that is too long", { header: HEADER, field: { key: "description", value: "x".repeat(2001) } }],
    ["a field that is not an object", { header: HEADER, field: "draft" }],
    ["a field that is null", { header: HEADER, field: null }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, header } = stub();
    expect((await handleHeader(at(sent), ALICE, deps, "1")).status).toBe(400);
    expect(header).not.toHaveBeenCalled();
  });
});

describe("making a whole vault encrypted or plaintext (RFC 0003)", () => {
  const BLOB = "a".repeat(40);
  const AGE = Buffer.from("age-encryption.org/v1\n-> X25519 abc\nbody").toString("base64");
  const valid = { vault: "Notes", direction: "encrypt", recipients: ["age1abc"], files: [{ path: "Notes/a.md", blob: BLOB, to: "Notes/a.md.age", content: AGE }] };
  const send = (value: unknown, init?: Parameters<typeof post>[1]) => {
    const request = post(value, init);
    return new Request(request.url.replace("/files", "/files/convert"), { method: "POST", headers: request.headers, body: typeof value === "string" ? value : JSON.stringify(value) });
  };

  it("hands the repository's rules the vault, the direction, the keys and each file's blob, names and decoded bytes, with the caller", async () => {
    const { deps, convert } = stub();
    const response = await handleConvert(send(valid), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ commit: "e".repeat(40), files: 0 });
    const given = convert.mock.calls[0]![2] as { vault: string; direction: string; recipients: string[]; files: { path: string; blob: string; to: string; content: Uint8Array }[] };
    expect([given.vault, given.direction, given.recipients]).toEqual(["Notes", "encrypt", ["age1abc"]]);
    expect([given.files[0]!.path, given.files[0]!.blob, given.files[0]!.to]).toEqual(["Notes/a.md", BLOB, "Notes/a.md.age"]);
    expect(Buffer.from(given.files[0]!.content).toString()).toContain("age-encryption.org/v1");
  });

  it("is for nobody signed out, nor from another site, nor a connection that is not a number, and asks nothing", async () => {
    const { deps, convert } = stub();
    expect((await handleConvert(send(valid), null, deps, "1")).status).toBe(401);
    for (const origin of ["https://evil.example", "null", null]) expect((await handleConvert(send(valid, { origin }), ALICE, deps, "1")).status).toBe(403);
    expect((await handleConvert(send(valid, { type: "text/plain" }), ALICE, deps, "1")).status).toBe(415);
    expect((await handleConvert(send(valid), ALICE, deps, "1/../2")).status).toBe(404);
    expect((await handleConvert(new Request(`${ORIGIN}/x`, { method: "GET" }), ALICE, deps, "1")).status).toBe(405);
    expect(convert).not.toHaveBeenCalled();
  });

  it.each([
    ["a vault that is a path", { vault: "Notes/Deep" }],
    ["no direction", { direction: "swap" }],
    ["recipients that are not text", { recipients: [5] }],
    ["a file with a way up in its name", { files: [{ path: "Notes/a.md", blob: BLOB, to: "Notes/../x.age", content: AGE }] }],
    ["a blob that is not an object id", { files: [{ path: "Notes/a.md", blob: "main", to: "Notes/a.md.age", content: AGE }] }],
    ["content that is not base64", { files: [{ path: "Notes/a.md", blob: BLOB, to: "Notes/a.md.age", content: "nope!" }] }],
  ])("refuses %s", async (_name, over) => {
    const { deps, convert } = stub();
    expect((await handleConvert(send({ ...valid, ...over }), ALICE, deps, "1")).status).toBe(400);
    expect(convert).not.toHaveBeenCalled();
  });

  it("says what it found when the files are not the vault's, and which, and a connection that is not the caller's is not found", async () => {
    const { deps, convert } = stub();
    convert.mockResolvedValueOnce({ found: true, result: { ok: false, reason: "missing_files", paths: ["Notes/b.md"] } });
    const response = await handleConvert(send(valid), ALICE, deps, "1");
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ error: { code: "missing_files" } });
    convert.mockResolvedValueOnce({ found: false });
    expect((await handleConvert(send(valid), ALICE, deps, "1")).status).toBe(404);
  });
});
