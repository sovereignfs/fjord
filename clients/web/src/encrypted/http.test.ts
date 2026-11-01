import { describe, expect, it, vi } from "vitest";
import { type Deps, MAX_CIPHERTEXT_BYTES, type Refusal, type RecipientsDeps, handleCiphertext, handleRecipients } from "./http";

/** The rules of `/api/connections/<id>/ciphertext` (ROADMAP 2b.2), with a stand-in for the repository: who may ask, what may be asked, what is handed back. */
const BYTES = new Uint8Array([0x61, 0x67, 0x65, 0x2d, 0xff, 0x00, 0x10]);
const ALICE = { accountId: "alice" };
const read = (result: Awaited<ReturnType<Deps["read"]>> = { found: true, result: { ok: true, bytes: BYTES } }) => vi.fn<Deps["read"]>(async () => result);
const ask = (deps: Deps, caller: { accountId: string } | null, id = "7", path: string | null = "Private/secret.md.age", method = "GET") =>
  handleCiphertext(new Request(`https://fjord.example/api/connections/${id}/ciphertext${path === null ? "" : `?path=${encodeURIComponent(path)}`}`, { method }), caller, deps, id);

describe("who may ask for the bytes of an encrypted file", () => {
  it("nobody who is not signed in, and nothing is read for them", async () => {
    const deps = { read: read() };
    const response = await ask(deps, null);
    expect(response.status).toBe(401);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("an account for its own connection, which is handed the file exactly as stored and told not to keep it", async () => {
    const deps = { read: read() };
    const response = await ask(deps, ALICE);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.read).toHaveBeenCalledWith("alice", 7, "Private/secret.md.age");
  });

  it("not another account for a connection that is not theirs: it is not found, as if it were not there", async () => {
    const response = await ask({ read: read({ found: false }) }, { accountId: "mallory" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "There is no such file." } });
  });

  it("only GET", async () => {
    const deps = { read: read() };
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await ask(deps, ALICE, "7", "a.age", method)).status, method).toBe(405);
    expect(deps.read).not.toHaveBeenCalled();
  });
});

describe("what may be asked", () => {
  it.each([null, "", "../x", "a/../b", "/abs", "a//b", "a\\b", "a\0b", `${"a/".repeat(600)}b`])("is refused for a path that is %j, before anything is read", async (path) => {
    const deps = { read: read() };
    expect((await ask(deps, ALICE, "7", path)).status).toBe(400);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "abc", "1.5", "7 ", "0007x"])("is a connection that is %j: not found, before anything is read", async (id) => {
    const deps = { read: read() };
    expect((await ask(deps, ALICE, id)).status).toBe(404);
    expect(deps.read).not.toHaveBeenCalled();
  });
});

describe("what is told when there are no bytes", () => {
  it.each<[Refusal, number, string]>([
    ["not_encrypted", 404, "not_found"],
    ["too_large", 413, "too_large"],
    ["bad_token", 422, "bad_token"],
    ["unavailable", 502, "unavailable"],
  ])("%s is %i", async (reason, status, code) => {
    const response = await ask({ read: read({ found: true, result: { ok: false, reason } }) }, ALICE);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it("a note in a plaintext vault is the same 404 as a file that is not there: nothing says which", async () => {
    const missing = await ask({ read: read({ found: true, result: { ok: false, reason: "not_encrypted" } }) }, ALICE, "7", "Public/idea.md");
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "There is no such file." } });
  });

  it("an error nobody expected is logged by its name, and the answer says nothing of it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await ask({ read: vi.fn(async () => Promise.reject(new RangeError("token ghp_secret in /path"))) }, ALICE);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("ghp_secret");
    expect(JSON.stringify(log.mock.calls)).not.toContain("ghp_secret");
    expect(log).toHaveBeenCalledWith("[fjord] ciphertext: unexpected RangeError");
    log.mockRestore();
  });

  it("is limited to what an encrypted document is meant to be", () => {
    expect(MAX_CIPHERTEXT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("the recipients of an encrypted vault (ROADMAP 2b.6)", () => {
  const KEYS = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n";
  const recipients = (result: Awaited<ReturnType<RecipientsDeps["read"]>> = { found: true, result: { ok: true, text: KEYS } }) => vi.fn<RecipientsDeps["read"]>(async () => result);
  const ask = (deps: RecipientsDeps, caller: { accountId: string } | null, id = "7", vault: string | null = "Private", method = "GET") =>
    handleRecipients(new Request(`https://fjord.example/api/connections/${id}/recipients${vault === null ? "" : `?vault=${encodeURIComponent(vault)}`}`, { method }), caller, deps, id);

  it("nobody who is not signed in, and nothing is read for them", async () => {
    const deps = { read: recipients() };
    expect((await ask(deps, null)).status).toBe(401);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("an account for its own connection, which is told the keys and not to keep them", async () => {
    const deps = { read: recipients() };
    const response = await ask(deps, ALICE);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ recipients: KEYS });
    expect(deps.read).toHaveBeenCalledWith("alice", 7, "Private");
  });

  it("not another account for a connection that is not theirs, nor a vault that is not an encrypted one, which are the same 404", async () => {
    expect((await ask({ read: recipients({ found: false }) }, { accountId: "mallory" })).status).toBe(404);
    const response = await ask({ read: recipients({ found: true, result: { ok: false, reason: "not_a_vault" } }) }, ALICE);
    expect([response.status, (await response.json()).error.code]).toEqual([404, "not_found"]);
  });

  it("says when a vault has no recipients to read, and when the host cannot be asked", async () => {
    expect((await ask({ read: recipients({ found: true, result: { ok: false, reason: "no_recipients" } }) }, ALICE)).status).toBe(422);
    expect((await ask({ read: recipients({ found: true, result: { ok: false, reason: "unavailable" } }) }, ALICE)).status).toBe(502);
  });

  it("only GET, for a vault named by its directory and a connection that is a number", async () => {
    const deps = { read: recipients() };
    for (const method of ["POST", "PUT", "DELETE"]) expect((await ask(deps, ALICE, "7", "Private", method)).status, method).toBe(405);
    for (const vault of [null, "", "a/b", "..", "a\u0000b"]) expect((await ask(deps, ALICE, "7", vault)).status, String(vault)).toBe(400);
    expect((await ask(deps, ALICE, "7/../8")).status).toBe(404);
    expect(deps.read).not.toHaveBeenCalled();
  });
});
