import { describe, expect, it, vi } from "vitest";
import type { LinkWithSecret } from "./links";
import { hashPassword, proofIsRight } from "./password";
import { newToken } from "./tokens";
import { parseShareCookie, tryUnlock } from "./unlock";

/**
 * Giving the password of a link (ROADMAP 1c.5): what is let in, what is turned away without being checked, what is counted, and what
 * the cookie that results holds. The store is a stand-in here; the tries' timing is `links.test.ts`'s.
 */
const NOW = 1_800_000_000_000;
const DOC = "01jagc4k7pt8y3wqnmzv5xrb8j";
const SECRET = "s".repeat(40);
const TOKEN = newToken();
const PASSWORD = "correct horse battery staple";

async function setup(over: Partial<LinkWithSecret> = {}, claim: { claimed: true } | { claimed: false; retryAt: number } = { claimed: true }) {
  const hash = await hashPassword(PASSWORD);
  const link: LinkWithSecret = { id: 4, connectionId: 1, docId: DOC, role: "view", expiresAt: null, revokedAt: null, createdAt: NOW - 1000, hasPassword: true, passwordHash: hash, failures: 0, lockedUntil: null, ...over };
  const links = {
    byToken: vi.fn(async (..._args: unknown[]) => link),
    claimTry: vi.fn(async (..._args: unknown[]) => claim),
    recordFailure: vi.fn(async (..._args: unknown[]) => undefined),
    recordSuccess: vi.fn(async (..._args: unknown[]) => undefined),
  };
  return { deps: { links, secret: SECRET, now: () => NOW }, links, link, hash };
}
const give = (password: unknown, over: { docId?: string; pendingToken?: string | undefined } = {}) => ({ docId: DOC, password, pendingToken: TOKEN, ...over });

describe("the right password", () => {
  it("gives the cookie that opens the link: the token and a proof bound to the link, its password and the server, for an hour", async () => {
    const { deps, link, hash } = await setup();
    const result = await tryUnlock(deps, give(PASSWORD));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { token, proof } = parseShareCookie(result.value);
    expect(token).toBe(TOKEN);
    expect(proofIsRight(SECRET, link.id, hash, proof)).toBe(true);
    expect(result.maxAgeSeconds).toBe(3600);
    expect(result.value).not.toContain(PASSWORD);
  });

  it("starts the tries again, and no longer than the link lives", async () => {
    const { deps, links } = await setup({ expiresAt: NOW + 90_000 });
    const result = await tryUnlock(deps, give(PASSWORD));
    expect(links.recordSuccess).toHaveBeenCalledWith(4);
    expect(result.ok && result.maxAgeSeconds).toBe(90);
  });
});

describe("a right password for a link that is about to end", () => {
  it("gives no cookie when it would last less than a second, rather than one that ends at once", async () => {
    const { deps } = await setup({ expiresAt: NOW + 500 });
    expect(await tryUnlock(deps, give(PASSWORD))).toEqual({ ok: false, reason: "gone" });
  });
});

describe("a wrong password", () => {
  it.each(["Correct horse battery staple", "correct horse battery stapl", "", "short", "x".repeat(500), undefined, 12345678, null])("%j is wrong, and counts", async (password) => {
    const { deps, links } = await setup();
    expect(await tryUnlock(deps, give(password))).toEqual({ ok: false, reason: "wrong" });
    expect(links.recordFailure).toHaveBeenCalledWith(4);
    expect(links.recordSuccess).not.toHaveBeenCalled();
  });

  it("is not hashed if it could not be one, so a huge one costs nothing", async () => {
    const { deps } = await setup();
    const verify = vi.fn(async () => true);
    expect(await tryUnlock({ ...deps, verify }, give("x".repeat(100_000)))).toEqual({ ok: false, reason: "wrong" });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("a try that comes too soon", () => {
  it("is turned away unchecked, even with the right password, and says when to come back", async () => {
    const { deps, links } = await setup({}, { claimed: false, retryAt: NOW + 4000 });
    const verify = vi.fn(async () => true);
    expect(await tryUnlock({ ...deps, verify }, give(PASSWORD))).toEqual({ ok: false, reason: "wait", retryAt: NOW + 4000 });
    expect(verify).not.toHaveBeenCalled();
    expect(links.recordFailure).not.toHaveBeenCalled();
    expect(links.recordSuccess).not.toHaveBeenCalled();
  });
});

describe("nothing to unlock", () => {
  const cases: [string, Partial<LinkWithSecret>][] = [
    ["a link of another document", { docId: "01jagc4k7pt8y3wqnmzv5xrbzz" }],
    ["an expired link", { expiresAt: NOW - 1 }],
    ["a link that expires this instant", { expiresAt: NOW }],
    ["a revoked link", { revokedAt: NOW - 5 }],
    ["a link with no password", { passwordHash: null, hasPassword: false }],
  ];
  it.each(cases)("%s is gone, with no try taken and none counted", async (_name, over) => {
    const { deps, links } = await setup(over);
    expect(await tryUnlock(deps, give(PASSWORD))).toEqual({ ok: false, reason: "gone" });
    expect(links.claimTry).not.toHaveBeenCalled();
    expect(links.recordFailure).not.toHaveBeenCalled();
  });

  it("is gone for no token, one that is not a token, or a document that is not an id, and a token that was never made", async () => {
    const { deps, links } = await setup();
    for (const input of [give(PASSWORD, { pendingToken: undefined }), give(PASSWORD, { pendingToken: "short" }), give(PASSWORD, { docId: "nope" })]) {
      expect(await tryUnlock(deps, input)).toEqual({ ok: false, reason: "gone" });
    }
    expect(links.byToken).not.toHaveBeenCalled();
    links.byToken.mockResolvedValueOnce(undefined as never);
    expect(await tryUnlock(deps, give(PASSWORD))).toEqual({ ok: false, reason: "gone" });
  });
});

describe("a cookie's value", () => {
  it("is the token alone for a link with no password, and the token and the proof for one with", () => {
    expect(parseShareCookie("abc")).toEqual({ token: "abc", proof: undefined });
    expect(parseShareCookie("abc.def")).toEqual({ token: "abc", proof: "def" });
    expect(parseShareCookie("abc.def.ghi")).toEqual({ token: "abc", proof: "def.ghi" });
    expect(parseShareCookie("")).toEqual({ token: "", proof: undefined });
  });
});
