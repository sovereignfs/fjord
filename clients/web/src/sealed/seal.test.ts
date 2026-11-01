import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import type { CryptoModule } from "../keys/module";
import { whyNotCiphertext } from "../working/ciphertext";
import { keyFragment, keyFromFragment, openShare, sealShare } from "./seal";

/** A sealed copy made and opened with the real module (ROADMAP 2c.1): what is in it, who can open it, and that the server's check accepts it as ciphertext. */
const available = wasmAvailable();
const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;
const DOC = { name: "Plan.fj.md", text: "---\nid: x\n---\n\n# Plan\n\nSECRET PLAINTEXT ünï 💧\n" };

describe.runIf(available)("a sealed copy", () => {
  it("in key mode is opened by the key it hands back, and by nothing else", () => {
    const module = load();
    const sealed = sealShare(module, { ...DOC, mode: "key" });
    expect(sealed.mode).toBe("key");
    if (sealed.mode !== "key") return;
    expect(sealed.key).toMatch(/^AGE-SECRET-KEY-1[A-Z0-9]+$/);
    expect(whyNotCiphertext(sealed.ciphertext)).toBeUndefined();
    expect(Buffer.from(sealed.ciphertext, "base64").toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(openShare(module, { mode: "key", ciphertext: sealed.ciphertext, secret: sealed.key })).toEqual({ ok: true, ...DOC });
    const other = sealShare(module, { ...DOC, mode: "key" });
    expect(openShare(module, { mode: "key", ciphertext: sealed.ciphertext, secret: (other as { key: string }).key })).toEqual({ ok: false, reason: "wrong_secret" });
    expect(openShare(module, { mode: "key", ciphertext: sealed.ciphertext, secret: "nonsense" })).toEqual({ ok: false, reason: "wrong_secret" });
  });

  it("gives a new key every time, so that revoking one share does not touch another", () => {
    const module = load();
    const keys = [1, 2, 3].map(() => (sealShare(module, { ...DOC, mode: "key" }) as { key: string }).key);
    expect(new Set(keys).size).toBe(3);
  });

  it("in password mode is opened by the password and by nothing else, and the password is long enough to be worth the wait", () => {
    const module = load();
    const sealed = sealShare(module, { ...DOC, mode: "password", password: "a password of some length" });
    expect(sealed).not.toHaveProperty("key");
    expect(whyNotCiphertext(sealed.ciphertext)).toBeUndefined();
    expect(Buffer.from(sealed.ciphertext, "base64").toString("latin1")).not.toContain("SECRET PLAINTEXT");
    expect(openShare(module, { mode: "password", ciphertext: sealed.ciphertext, secret: "a password of some length" })).toEqual({ ok: true, ...DOC });
    expect(openShare(module, { mode: "password", ciphertext: sealed.ciphertext, secret: "another password entirely" })).toEqual({ ok: false, reason: "wrong_secret" });
    expect(() => sealShare(module, { ...DOC, mode: "password", password: "short" })).toThrow();
  });

  it("is not opened as the other mode", () => {
    const module = load();
    const sealed = sealShare(module, { ...DOC, mode: "key" }) as { ciphertext: string; key: string };
    expect(openShare(module, { mode: "password", ciphertext: sealed.ciphertext, secret: sealed.key })).toEqual({ ok: false, reason: "wrong_secret" });
  });

  it("says a copy that opened but is not a share's is damaged", () => {
    const module = load();
    const identity = module.generateIdentity();
    const plain = module.encrypt(new TextEncoder().encode("not json"), `${module.identityRecipient(identity)}\n`, false);
    expect(openShare(module, { mode: "key", ciphertext: Buffer.from(plain).toString("base64"), secret: new TextDecoder().decode(identity) })).toEqual({ ok: false, reason: "damaged" });
  });
});

describe("the key in a link", () => {
  it("is in the fragment as key=, and only a key is taken from one", () => {
    const key = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    expect(keyFromFragment(keyFragment(key))).toBe(key);
    for (const fragment of ["", "#", "#key=", "#key=not a key", "#other=" + key, key, "#key=" + key.toLowerCase()]) expect(keyFromFragment(fragment), fragment).toBeUndefined();
  });
});
