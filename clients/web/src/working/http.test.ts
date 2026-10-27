import { describe, expect, it, vi } from "vitest";
import { CredentialError } from "../crypto/errors";
import { ProviderError } from "../providers/errors";
import { type Caller, type Deps, MAX_BODY_CHARS, type SaveOutcome, handleResolve, handleVersion, handleWorkingCopy, isRepositoryPath } from "./http";
import type { ResolveResult } from "./resolve";
import { MAX_MESSAGE_CHARS, type VersionResult } from "./version";

/**
 * Who may call `/api/connections/<id>/working-copy`, from where, with what, and what they are told: the rules of
 * `http.ts` with a stand-in for what is behind it, so each is tested on its own. Storage on real databases is
 * `service.test.ts`; the rules for starting a draft are `access.test.ts`; the whole of it in a browser is `e2e/`.
 */
const ORIGIN = "https://fjord.example.com";
const ALICE: Caller = { accountId: "alice", name: "Alice Example", email: "alice@example.com" };
const BLOB = "a".repeat(40);
const COPY = { path: "Notes/a.md", baseBlob: BLOB, content: "SECRET TEXT", editors: [{ type: "account" as const, id: "alice" }], createdAt: 10, lastEdit: 20 };

function stub(outcome: SaveOutcome = { found: true, result: { ok: true, workingCopy: COPY } }) {
  const save = vi.fn(async (..._args: unknown[]): Promise<SaveOutcome> => outcome);
  const discard = vi.fn(async (..._args: unknown[]) => ({ found: true }));
  const saveVersion = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: VersionResult }> => ({ found: true, result: { ok: true, commit: "c".repeat(40) } }));
  const resolve = vi.fn(async (..._args: unknown[]): Promise<{ found: false } | { found: true; result: ResolveResult }> => ({ found: true, result: { ok: true, conflicts: 0 } }));
  const deps: Deps = {
    save: (accountId, id, input) => save(accountId, id, input),
    discard: (accountId, id, path) => discard(accountId, id, path),
    saveVersion: (accountId, id, input) => saveVersion(accountId, id, input),
    resolve: (accountId, id, input) => resolve(accountId, id, input),
    origin: ORIGIN,
  };
  return { deps, save, discard, saveVersion, resolve };
}

const put = (body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/working-copy`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const del = (path: string | null, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/connections/1/working-copy${path === null ? "" : `?path=${encodeURIComponent(path)}`}`, { method: "DELETE", headers: origin === null ? {} : { origin } });

const valid = { path: "Notes/a.md", baseBlob: BLOB, content: "hello" };
const body = async (response: Response) => JSON.parse(await response.text());

describe("who may call", () => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, save, discard } = stub();
    expect((await handleWorkingCopy(put(valid), null, deps, "1")).status).toBe(401);
    expect((await handleWorkingCopy(del("Notes/a.md"), null, deps, "1")).status).toBe(401);
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("refuses a write that does not come from this site, even from a signed-in person", async () => {
    const { deps, save, discard } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", `${ORIGIN}.evil.example`, "null", null]) {
      expect((await handleWorkingCopy(put(valid, { origin }), ALICE, deps, "1")).status).toBe(403);
      expect((await handleWorkingCopy(del("Notes/a.md", origin), ALICE, deps, "1")).status).toBe(403);
    }
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("allows only PUT and DELETE", async () => {
    const { deps } = stub();
    for (const method of ["GET", "POST", "PATCH"]) {
      const response = await handleWorkingCopy(new Request(`${ORIGIN}/api/connections/1/working-copy`, { method, headers: { origin: ORIGIN } }), ALICE, deps, "1");
      expect(response.status).toBe(405);
    }
  });

  it("asks for the caller's own account, and a connection that is not theirs is a 404 saying nothing else", async () => {
    const { deps, save, discard } = stub({ found: false });
    discard.mockResolvedValue({ found: false });
    const saved = await handleWorkingCopy(put(valid), ALICE, deps, "1");
    const discarded = await handleWorkingCopy(del("Notes/a.md"), ALICE, deps, "1");
    expect([saved.status, discarded.status]).toEqual([404, 404]);
    expect(save).toHaveBeenCalledWith("alice", 1, valid);
    expect(discard).toHaveBeenCalledWith("alice", 1, "Notes/a.md");
    expect((await body(saved)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });

  it.each(["0", "01", "-1", "1.5", "abc", "", "1e3", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, save, discard } = stub();
    expect((await handleWorkingCopy(put(valid), ALICE, deps, id)).status).toBe(404);
    expect((await handleWorkingCopy(del("Notes/a.md"), ALICE, deps, id)).status).toBe(404);
    expect(save).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });
});

describe("what may be sent", () => {
  it("keeps the draft and answers with when, never with the text", async () => {
    const { deps, save } = stub();
    const response = await handleWorkingCopy(put(valid), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(save).toHaveBeenCalledWith("alice", 1, valid);
    const text = JSON.stringify(await body(response));
    expect(JSON.parse(text)).toEqual({ workingCopy: { baseBlob: BLOB, createdAt: 10, lastEdit: 20 } });
    expect(text).not.toContain("SECRET TEXT");
  });

  it("keeps text exactly as sent, empty included", async () => {
    const { deps, save } = stub();
    const content = "  \r\n​ tab\t \u0001 💧 \n";
    await handleWorkingCopy(put({ ...valid, content }), ALICE, deps, "1");
    await handleWorkingCopy(put({ ...valid, content: "" }), ALICE, deps, "1");
    expect(save.mock.calls.map((call) => (call[2] as { content: string }).content)).toEqual([content, ""]);
  });

  it("wants JSON", async () => {
    const { deps, save } = stub();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", null]) {
      expect((await handleWorkingCopy(put(valid, { type }), ALICE, deps, "1")).status).toBe(415);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"text"'],
    ["no path", { baseBlob: BLOB, content: "x" }],
    ["no base", { path: "a.md", content: "x" }],
    ["no content", { path: "a.md", baseBlob: BLOB }],
    ["content that is not text", { ...valid, content: 5 }],
    ["a path that is not text", { ...valid, path: 5 }],
    ["an empty path", { ...valid, path: "" }],
    ["a path out of the repository", { ...valid, path: "../a.md" }],
    ["a path through it", { ...valid, path: "Notes/../../a.md" }],
    ["a path with an empty step", { ...valid, path: "Notes//a.md" }],
    ["an absolute path", { ...valid, path: "/Notes/a.md" }],
    ["a path with backslashes", { ...valid, path: "Notes\\a.md" }],
    ["a path with a NUL", { ...valid, path: "Notes/a\u0000.md" }],
    ["a path that is too long", { ...valid, path: `${"a".repeat(1025)}.md` }],
    ["a base that is not an object id", { ...valid, baseBlob: "main" }],
    ["a short base", { ...valid, baseBlob: "abc123" }],
    ["a base in capitals", { ...valid, baseBlob: "A".repeat(40) }],
    ["a base with a suffix", { ...valid, baseBlob: `${BLOB}0` }],
  ])("refuses %s with 400", async (_name, sent) => {
    const { deps, save } = stub();
    const response = await handleWorkingCopy(put(sent), ALICE, deps, "1");
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe("invalid_request");
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts a SHA-256 object id for the base, as git can use", async () => {
    const { deps } = stub();
    expect((await handleWorkingCopy(put({ ...valid, baseBlob: "b".repeat(64) }), ALICE, deps, "1")).status).toBe(200);
  });

  it("refuses a body that is too large with 413, without asking", async () => {
    const { deps, save } = stub();
    const response = await handleWorkingCopy(put({ ...valid, content: "x".repeat(MAX_BODY_CHARS) }), ALICE, deps, "1");
    expect(response.status).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });

  it("takes the biggest text a note can be, even when JSON spells every character in six", async () => {
    const { deps, save } = stub();
    const response = await handleWorkingCopy(put({ ...valid, content: "\u0001".repeat(1024 * 1024) }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledOnce();
  });

  it("DELETE needs the path, in the address", async () => {
    const { deps, discard } = stub();
    expect((await handleWorkingCopy(del(null), ALICE, deps, "1")).status).toBe(400);
    expect((await handleWorkingCopy(del("../x"), ALICE, deps, "1")).status).toBe(400);
    expect((await handleWorkingCopy(del("Notes/a.md"), ALICE, deps, "1")).status).toBe(204);
    expect(discard).toHaveBeenCalledOnce();
  });

  it("knows a repository path when it sees one", () => {
    expect(["a.md", "Notes/a b.md", "Notes/ü/日本.md", "a/.hidden", "a/..b"].map(isRepositoryPath)).toEqual([true, true, true, true, true]);
    expect(["", ".", "..", "a/.", "a/../b", "/a", "a/", "a//b", "a\\b", "a\u0000b", "a\ud800b", 5, null, undefined].map(isRepositoryPath)).toEqual(Array(14).fill(false));
  });
});

describe("what they are told", () => {
  it.each<[string, SaveOutcome, number, string]>([
    ["a draft of another version", { found: true, result: { ok: false, reason: "base_mismatch", baseBlob: "c".repeat(40) } }, 409, "base_mismatch"],
    ["text that cannot be kept", { found: true, result: { ok: false, reason: "unstorable", message: "It contains a NUL character." } }, 422, "unstorable"],
    ["too many drafts", { found: true, result: { ok: false, reason: "too_many" } }, 422, "too_many_drafts"],
    ["a file that is not an editable note", { found: true, result: { ok: false, reason: "not_editable" } }, 422, "not_editable"],
    ["a host that cannot be reached", { found: true, result: { ok: false, reason: "unavailable" } }, 502, "unavailable"],
  ])("%s", async (_name, outcome, status, code) => {
    const { deps } = stub(outcome);
    const response = await handleWorkingCopy(put(valid), ALICE, deps, "1");
    expect(response.status).toBe(status);
    expect((await body(response)).error.code).toBe(code);
  });

  it("says which base the draft is of, so the page can tell", async () => {
    const { deps } = stub({ found: true, result: { ok: false, reason: "base_mismatch", baseBlob: "c".repeat(40) } });
    expect((await body(await handleWorkingCopy(put(valid), ALICE, deps, "1"))).error.baseBlob).toBe("c".repeat(40));
  });

  it("answers an unexpected failure plainly, and logs its name and not its text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, save } = stub();
    save.mockRejectedValue(new Error("connection string postgres://user:hunter2@db/fjord, text SECRET TEXT"));
    const response = await handleWorkingCopy(put(valid), ALICE, deps, "1");
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toMatch(/hunter2|SECRET|postgres/);
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/hunter2|SECRET|postgres/);
    error.mockRestore();
  });

  it("says when the instance cannot read repositories, and when the host is limiting", async () => {
    const { deps, save } = stub();
    save.mockRejectedValueOnce(new CredentialError("no_key", "no key"));
    expect((await handleWorkingCopy(put(valid), ALICE, deps, "1")).status).toBe(503);
    save.mockRejectedValueOnce(new ProviderError("rate_limited", "slow down"));
    expect((await handleWorkingCopy(put(valid), ALICE, deps, "1")).status).toBe(429);
  });
});

// --- Versions (ROADMAP 1b.9) ------------------------------------------------------------------------------------

const post = (body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/working-copy/version`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};

describe("making a version: who may", () => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, saveVersion } = stub();
    expect((await handleVersion(post({ path: "a.md" }), null, deps, "1")).status).toBe(401);
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it("not from another site, even for a signed-in person", async () => {
    const { deps, saveVersion } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) {
      expect((await handleVersion(post({ path: "a.md" }, { origin }), ALICE, deps, "1")).status).toBe(403);
    }
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it("only POST", async () => {
    const { deps } = stub();
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await handleVersion(new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN } }), ALICE, deps, "1")).status).toBe(405);
    }
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, saveVersion } = stub();
    saveVersion.mockResolvedValue({ found: false });
    const response = await handleVersion(post({ path: "a.md" }), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });

  it.each(["0", "01", "-1", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, saveVersion } = stub();
    expect((await handleVersion(post({ path: "a.md" }), ALICE, deps, id)).status).toBe(404);
    expect(saveVersion).not.toHaveBeenCalled();
  });
});

describe("making a version: what may be sent", () => {
  it("credits the caller, as the account names them, and never someone the request names", async () => {
    const { deps, saveVersion } = stub();
    const response = await handleVersion(post({ path: "Notes/a.md", message: "Reword", author: { name: "Mallory", email: "m@evil.example" }, name: "Mallory" }), ALICE, deps, "1");
    expect(response.status).toBe(201);
    expect(await body(response)).toEqual({ commit: "c".repeat(40) });
    expect(saveVersion).toHaveBeenCalledWith("alice", 1, { path: "Notes/a.md", message: "Reword", author: { name: "Alice Example", email: "alice@example.com" } });
  });

  it("takes no message, or null, as the default", async () => {
    const { deps, saveVersion } = stub();
    await handleVersion(post({ path: "a.md" }), ALICE, deps, "1");
    await handleVersion(post({ path: "a.md", message: null }), ALICE, deps, "1");
    expect(saveVersion.mock.calls.map((call) => (call[2] as { message: unknown }).message)).toEqual([undefined, undefined]);
  });

  it("wants JSON", async () => {
    const { deps, saveVersion } = stub();
    for (const type of ["text/plain", null]) expect((await handleVersion(post({ path: "a.md" }, { type }), ALICE, deps, "1")).status).toBe(415);
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no path", {}],
    ["a path out of the repository", { path: "../a.md" }],
    ["a path that is not text", { path: 5 }],
    ["a message that is not text", { path: "a.md", message: 5 }],
    ["a message with a NUL", { path: "a.md", message: "a\u0000b" }],
    ["a message with an unpaired surrogate", { path: "a.md", message: "a\ud800b" }],
    ["a message that is too long", { path: "a.md", message: "x".repeat(MAX_MESSAGE_CHARS + 1) }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, saveVersion } = stub();
    expect((await handleVersion(post(sent), ALICE, deps, "1")).status).toBe(400);
    expect(saveVersion).not.toHaveBeenCalled();
  });

  it("takes a message of exactly the longest length", async () => {
    const { deps } = stub();
    expect((await handleVersion(post({ path: "a.md", message: "x".repeat(MAX_MESSAGE_CHARS) }), ALICE, deps, "1")).status).toBe(201);
  });

  it("refuses a body that is far too large with 413", async () => {
    const { deps, saveVersion } = stub();
    expect((await handleVersion(post({ path: "a.md", message: "y".repeat(100_000) }), ALICE, deps, "1")).status).toBe(413);
    expect(saveVersion).not.toHaveBeenCalled();
  });
});

describe("making a version: what they are told", () => {
  it.each<[Extract<VersionResult, { ok: false }>["reason"], number]>([
    ["no_draft", 409],
    ["nothing_to_save", 409],
    ["upstream_changed", 409],
    ["gone", 409],
    ["head_moved", 409],
    ["read_only", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code, and says whether the changes are kept", async (reason, status) => {
    const { deps, saveVersion } = stub();
    saveVersion.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleVersion(post({ path: "a.md" }), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(20);
    if (reason !== "no_draft" && reason !== "nothing_to_save") expect(error.message).toMatch(/kept|Try again/);
  });

  it("answers an unexpected failure plainly, and logs its name and not its text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, saveVersion } = stub();
    saveVersion.mockRejectedValue(new Error("token github_pat_SECRET at postgres://user:hunter2@db"));
    const response = await handleVersion(post({ path: "a.md" }), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|hunter2/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/SECRET|hunter2/);
    logged.mockRestore();
  });
});

// --- Going on after the file changed (ROADMAP 1b.10) ---------------------------------------------------------------

const UPSTREAM = "d".repeat(40);
const resolvePost = (body: unknown, init: { origin?: string | null; type?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? "application/json";
  return new Request(`${ORIGIN}/api/connections/1/working-copy/resolve`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
};
const choice = { path: "Notes/a.md", choice: "combine", upstreamBlob: UPSTREAM };

describe("going on: who may", () => {
  it("nobody who is not signed in: 401, and nothing is asked", async () => {
    const { deps, resolve } = stub();
    expect((await handleResolve(resolvePost(choice), null, deps, "1")).status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("not from another site", async () => {
    const { deps, resolve } = stub();
    for (const origin of ["https://evil.example", "http://fjord.example.com", "null", null]) {
      expect((await handleResolve(resolvePost(choice, { origin }), ALICE, deps, "1")).status).toBe(403);
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("only POST", async () => {
    const { deps } = stub();
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await handleResolve(new Request(`${ORIGIN}/x`, { method, headers: { origin: ORIGIN } }), ALICE, deps, "1")).status).toBe(405);
    }
  });

  it("not another account's connection: a 404 that says nothing else", async () => {
    const { deps, resolve } = stub();
    resolve.mockResolvedValue({ found: false });
    const response = await handleResolve(resolvePost(choice), ALICE, deps, "1");
    expect(response.status).toBe(404);
    expect((await body(response)).error).toEqual({ code: "not_found", message: "There is no such connection." });
  });

  it.each(["0", "01", "x", "", "99999999999999999"])("a connection id like %j is a 404 before anything is asked", async (id) => {
    const { deps, resolve } = stub();
    expect((await handleResolve(resolvePost(choice), ALICE, deps, id)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("going on: what may be sent", () => {
  it.each(["mine", "combine"])("asks for %s, for the caller, about the version they were shown, and answers with how many conflicts", async (which) => {
    const { deps, resolve } = stub();
    resolve.mockResolvedValue({ found: true, result: { ok: true, conflicts: 2 } });
    const response = await handleResolve(resolvePost({ ...choice, choice: which, text: "the browser's idea of the merged text" }), ALICE, deps, "1");
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ conflicts: 2 });
    // Only the choice goes on: never a text from the browser.
    expect(resolve).toHaveBeenCalledWith("alice", 1, { path: "Notes/a.md", choice: which, upstreamBlob: UPSTREAM });
  });

  it("wants JSON", async () => {
    const { deps, resolve } = stub();
    for (const type of ["text/plain", null]) expect((await handleResolve(resolvePost(choice, { type }), ALICE, deps, "1")).status).toBe(415);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[]"],
    ["no path", { choice: "mine", upstreamBlob: UPSTREAM }],
    ["a path out of the repository", { ...choice, path: "../a.md" }],
    ["no choice", { path: "a.md", upstreamBlob: UPSTREAM }],
    ["taking theirs, which is throwing the draft away", { ...choice, choice: "theirs" }],
    ["a choice that is not one", { ...choice, choice: "overwrite" }],
    ["no version", { path: "a.md", choice: "mine" }],
    ["a version that is not an object id", { ...choice, upstreamBlob: "main" }],
    ["a version in capitals", { ...choice, upstreamBlob: "D".repeat(40) }],
  ])("refuses %s with 400, without asking", async (_name, sent) => {
    const { deps, resolve } = stub();
    expect((await handleResolve(resolvePost(sent), ALICE, deps, "1")).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a body that is far too large with 413", async () => {
    const { deps, resolve } = stub();
    expect((await handleResolve(resolvePost({ ...choice, extra: "x".repeat(20_000) }), ALICE, deps, "1")).status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("going on: what they are told", () => {
  it.each<[Extract<ResolveResult, { ok: false }>["reason"], number]>([
    ["no_draft", 409],
    ["up_to_date", 409],
    ["gone", 409],
    ["upstream_moved", 409],
    ["draft_changed", 409],
    ["unreadable", 422],
    ["unstorable", 422],
    ["bad_token", 422],
    ["unavailable", 502],
  ])("%s is %i, with its own code and words", async (reason, status) => {
    const { deps, resolve } = stub();
    resolve.mockResolvedValue({ found: true, result: { ok: false, reason } });
    const response = await handleResolve(resolvePost(choice), ALICE, deps, "1");
    const error = (await body(response)).error;
    expect(response.status).toBe(status);
    expect(error.code).toBe(reason);
    expect(error.message.length).toBeGreaterThan(20);
  });

  it("answers an unexpected failure plainly, and logs its name and not its text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, resolve } = stub();
    resolve.mockRejectedValue(new Error("token github_pat_SECRET at postgres://user:hunter2@db"));
    const response = await handleResolve(resolvePost(choice), ALICE, deps, "1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/SECRET|hunter2/);
    expect(logged.mock.calls.flat().join(" ")).not.toMatch(/SECRET|hunter2/);
    logged.mockRestore();
  });
});
