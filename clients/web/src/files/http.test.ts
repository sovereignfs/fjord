import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import type { Caller } from "../working/http";
import { type CreateResult, MAX_TITLE_CHARS, type VaultRefusal } from "./create";
import type { DeleteResult } from "./delete";
import { type Deps, handleCreate, handleDelete, handleHeader, handleMove, handleRestore } from "./http";
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
const valid = { vault: "Notes", folder: "Projects", kind: "note", title: "Plan", localMinute: WHEN };

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
  const header = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: { ok: true; header: string } | { ok: false; reason: "unreadable" } }> => ({
    found: true,
    result: { ok: true, header: "---\ntitle: New\n---\n" },
  }));
  const deps: Deps = {
    header: (accountId, id, input) => header(accountId, id, input),
    move: (accountId, id, input) => move(accountId, id, input),
    create: (accountId, id, input) => create(accountId, id, input),
    delete: (accountId, id, input) => remove(accountId, id, input),
    restore: (accountId, id, input) => restore(accountId, id, input),
    origin: ORIGIN,
  };
  return { deps, create, remove, restore, header, move };
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
    ["a vault with a slash", { ...delFile, vault: "Notes/Inner" }],
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
