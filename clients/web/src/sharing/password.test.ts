import { describe, expect, it } from "vitest";
import { ARGON2, MAX_PASSWORD_CHARS, MIN_PASSWORD_CHARS, hashPassword, isAcceptablePassword, proofIsRight, unlockProof, verifyPassword, waitAfter } from "./password";

/** Passwords on share links (ROADMAP 1c.5): Argon2id, kept as a hash that carries its own parameters. */
describe("hashing a password", () => {
  it("is Argon2id in a PHC string with the OWASP minimum parameters, and not the password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain("correct");
    expect(ARGON2).toMatchObject({ memory: 19456, passes: 2, parallelism: 1 });
  });

  it("is salted: the same password hashes differently each time, and both are right", async () => {
    const [a, b] = await Promise.all([hashPassword("correct horse battery staple"), hashPassword("correct horse battery staple")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery staple", b)).toBe(true);
  });

  it("verifies the password it hashed and nothing else, case, spaces and one character included", async () => {
    const hash = await hashPassword("correct horse battery staple");
    for (const wrong of ["Correct horse battery staple", "correct horse battery staple ", "correct horse battery stapl", "incorrect horse battery staple", "         "]) {
      expect(await verifyPassword(wrong, hash), wrong).toBe(false);
    }
  });

  it("keeps Unicode passwords as they are", async () => {
    const hash = await hashPassword("пароль-密码-🔑-longer");
    expect(await verifyPassword("пароль-密码-🔑-longer", hash)).toBe(true);
    expect(await verifyPassword("пароль-密码-🔑-longe", hash)).toBe(false);
  });

  it("checks against the parameters the hash carries, so they can be raised later", async () => {
    const { argon2Sync } = await import("node:crypto");
    const salt = Buffer.alloc(16, 7);
    const key = argon2Sync("argon2id", { message: "an older password", nonce: salt, parallelism: 1, tagLength: 32, memory: 8192, passes: 3 });
    const stored = `$argon2id$v=19$m=8192,t=3,p=1$${salt.toString("base64").replace(/=+$/, "")}$${key.toString("base64").replace(/=+$/, "")}`;
    expect(await verifyPassword("an older password", stored)).toBe(true);
    expect(await verifyPassword("another password", stored)).toBe(false);
  });

  it("says no, never throws, to something that is not a hash of ours or that asks for too much", async () => {
    const real = await hashPassword("correct horse battery staple");
    for (const bad of ["", "plain", "$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(43), real.replace("m=19456", "m=99999999"), real.replace("t=2", "t=999"), real.replace("p=1", "p=64"), real.slice(0, -10), `${real}x!`, "$argon2id$v=19$m=8,t=1,p=1$AA$AA"]) {
      expect(await verifyPassword("correct horse battery staple", bad), bad).toBe(false);
    }
    expect(await verifyPassword("short", real)).toBe(false);
  });
});

describe("what a password may be", () => {
  it("is eight to two hundred characters of well-formed text without a NUL", () => {
    expect(isAcceptablePassword("a".repeat(MIN_PASSWORD_CHARS))).toBe(true);
    expect(isAcceptablePassword("a".repeat(MAX_PASSWORD_CHARS))).toBe(true);
    for (const bad of ["a".repeat(MIN_PASSWORD_CHARS - 1), "a".repeat(MAX_PASSWORD_CHARS + 1), "", "abcdefg\0h", "abcdefg\ud800", 12345678, null, undefined, ["abcdefgh"]]) expect(isAcceptablePassword(bad), String(bad)).toBe(false);
  });
});

describe("the proof that the password was given", () => {
  const secret = "s".repeat(40);
  it("is right for that link, its password and the server's secret, and wrong for any other", () => {
    const proof = unlockProof(secret, 7, "$argon2id$one");
    expect(proofIsRight(secret, 7, "$argon2id$one", proof)).toBe(true);
    expect(proofIsRight(secret, 8, "$argon2id$one", proof)).toBe(false); // another link
    expect(proofIsRight(secret, 7, "$argon2id$two", proof)).toBe(false); // the password was changed
    expect(proofIsRight("t".repeat(40), 7, "$argon2id$one", proof)).toBe(false); // another server's
    for (const bad of [undefined, "", proof.slice(0, -1), `${proof}x`, "A".repeat(proof.length)]) expect(proofIsRight(secret, 7, "$argon2id$one", bad)).toBe(false);
  });

  it("holds nothing of the password hash that could be read back", () => {
    expect(unlockProof(secret, 7, "$argon2id$one")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("the wait between tries", () => {
  it("is a second for the first few, then five seconds doubling to a quarter of an hour", () => {
    expect([0, 1, 2].map(waitAfter)).toEqual([1000, 1000, 1000]);
    expect([3, 4, 5, 6].map(waitAfter)).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(waitAfter(30)).toBe(15 * 60 * 1000);
    expect(waitAfter(1000)).toBe(15 * 60 * 1000);
  });
});
