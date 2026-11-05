import { describe, expect, it, vi } from "vitest";
import type { Taken } from "../limits/rate";
import { type AccountDeps, type Caller, PASSWORD_TRIES, handleDeleteAccount } from "./http";

const ORIGIN = "https://fjord.example.com";
const ADA: Caller = { accountId: "ada", email: "ada@example.com" };
const GOOD = { confirm: "ada@example.com", password: "the password" };

function stub(over: Partial<AccountDeps> = {}) {
  const deleteAccount = vi.fn(async () => undefined);
  const take = vi.fn(async () => ({ ok: true } as Taken));
  const deps: AccountDeps = {
    origin: ORIGIN,
    hasPassword: async () => true,
    passwordIs: async (password) => password === "the password",
    limiter: { take } as unknown as AccountDeps["limiter"],
    deleteAccount,
    endingCookies: async () => ["fjord.session_token=; Max-Age=0"],
    ...over,
  };
  return { deps, deleteAccount, take };
}

const post = (body: unknown, init: { origin?: string | null; method?: string; type?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": init.type ?? "application/json" };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return new Request(`${ORIGIN}/api/account/delete`, { method: init.method ?? "POST", headers, ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }) });
};
const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code;

describe("deleting an account", () => {
  it("needs someone signed in, on this site, sending JSON, by POST", async () => {
    const { deps, deleteAccount } = stub();
    expect((await handleDeleteAccount(post(GOOD), null, deps)).status).toBe(401);
    expect((await handleDeleteAccount(post(GOOD, { origin: "https://evil.example" }), ADA, deps)).status).toBe(403);
    expect((await handleDeleteAccount(post(GOOD, { origin: null }), ADA, deps)).status).toBe(403);
    expect((await handleDeleteAccount(post(GOOD, { type: "text/plain" }), ADA, deps)).status).toBe(415);
    expect((await handleDeleteAccount(post(GOOD, { method: "GET" }), ADA, deps)).status).toBe(405);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("needs the address typed out, and it must be the caller's own", async () => {
    const { deps, deleteAccount } = stub();
    for (const confirm of ["", "someone@example.com", undefined, 7]) {
      const response = await handleDeleteAccount(post({ ...GOOD, confirm }), ADA, deps);
      expect(response.status).toBe(422);
      expect(await code(response)).toBe("not_confirmed");
    }
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("needs the password of an account that has one, and says nothing was done", async () => {
    const { deps, deleteAccount } = stub();
    for (const password of ["wrong", "", undefined]) {
      const response = await handleDeleteAccount(post({ ...GOOD, password }), ADA, deps);
      expect(response.status).toBe(422);
      expect(await code(response)).toBe("wrong_password");
    }
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("is not a way to guess a password: tries are counted per account, before the password is asked", async () => {
    const passwordIs = vi.fn(async () => true);
    const { deps, deleteAccount, take } = stub({ passwordIs });
    take.mockResolvedValueOnce({ ok: false, retryAfterMs: 1000 });
    const response = await handleDeleteAccount(post(GOOD), ADA, deps);
    expect(response.status).toBe(429);
    expect(passwordIs).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(take).toHaveBeenCalledWith("account:ada:password", PASSWORD_TRIES);
  });

  it("asks for no password of an account that has none (it signs in through Sovereign)", async () => {
    const { deps, deleteAccount } = stub({ hasPassword: async () => false });
    expect((await handleDeleteAccount(post({ confirm: "ADA@example.com " }), ADA, deps)).status).toBe(200);
    expect(deleteAccount).toHaveBeenCalledWith("ada");
  });

  it("deletes the caller's account and no other, whatever is sent, and ends the session in this browser", async () => {
    const { deps, deleteAccount } = stub();
    const response = await handleDeleteAccount(post({ ...GOOD, accountId: "mallory" }), ADA, deps);
    expect(response.status).toBe(200);
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith("ada");
    expect(response.headers.getSetCookie()).toEqual(["fjord.session_token=; Max-Age=0"]);
  });

  it("answers the unexpected plainly", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = stub({ deleteAccount: async () => { throw new Error("secret detail"); } });
    const response = await handleDeleteAccount(post(GOOD), ADA, deps);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
    quiet.mockRestore();
  });
});
