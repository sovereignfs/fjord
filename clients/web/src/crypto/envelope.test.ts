import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isCredentialError } from "./errors";
import { open, rewrap, seal } from "./envelope";
import { Keyring } from "./keyring";

const key = () => randomBytes(32);
const binding = { id: "cred-1", purpose: "github-pat" };
const SECRET = "ghp_ExampleToken0123456789abcdefghijklmnop";

describe("sealing a credential", () => {
  it("opens to what was sealed, and holds nothing readable of it", () => {
    const ring = new Keyring(key());
    const sealed = seal(ring, binding, SECRET);
    expect(open(ring, binding, sealed)).toBe(SECRET);
    for (const field of [sealed.ciphertext, sealed.wrappedKey]) {
      expect(field).not.toContain(SECRET);
      expect(Buffer.from(field.split(".")[1]!, "base64url").toString("latin1")).not.toContain("ghp_");
    }
    expect(sealed.kekId).toBe(ring.current.id);
  });

  it("round-trips what is not ASCII and what is empty or long", () => {
    const ring = new Keyring(key());
    for (const text of ["", "søren ✓ 日本語", "x".repeat(20_000), "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"]) {
      expect(open(ring, binding, seal(ring, binding, text))).toBe(text);
    }
  });

  it("is different every time: a fresh data key and a fresh nonce, so equal secrets look unrelated", () => {
    const ring = new Keyring(key());
    const a = seal(ring, binding, SECRET);
    const b = seal(ring, binding, SECRET);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
  });

  it("never uses a nonce twice under the instance key: two wrapped keys never share one", () => {
    const ring = new Keyring(key());
    const nonces = new Set<string>();
    for (let i = 0; i < 500; i++) nonces.add(Buffer.from(seal(ring, binding, "x").wrappedKey.split(".")[1]!, "base64url").subarray(0, 12).toString("hex"));
    expect(nonces.size).toBe(500);
  });

  it("does not open under another key", () => {
    const sealed = seal(new Keyring(key()), binding, SECRET);
    expect(() => open(new Keyring(key()), binding, sealed)).toThrow(expect.objectContaining({ code: "unknown_key" }));
    // The right fingerprint, wrong key is not possible to configure, but a forged kekId must not help either.
    const ring = new Keyring(key());
    expect(() => open(ring, binding, { ...sealed, kekId: ring.current.id })).toThrow(expect.objectContaining({ code: "corrupt" }));
  });

  describe("is refused when what is stored is not what was sealed", () => {
    const ring = new Keyring(key());
    const sealed = seal(ring, binding, SECRET);
    const flip = (value: string) => {
      const [version, body] = value.split(".") as [string, string];
      const bytes = Buffer.from(body, "base64url");
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      return `${version}.${bytes.toString("base64url")}`;
    };

    it("when the credential has been altered", () => {
      expect(() => open(ring, binding, { ...sealed, ciphertext: flip(sealed.ciphertext) })).toThrow(expect.objectContaining({ code: "corrupt" }));
    });

    it("when the wrapped key has been altered", () => {
      expect(() => open(ring, binding, { ...sealed, wrappedKey: flip(sealed.wrappedKey) })).toThrow(expect.objectContaining({ code: "corrupt" }));
    });

    it("when it is moved to another row", () => {
      expect(() => open(ring, { ...binding, id: "cred-2" }, sealed)).toThrow(expect.objectContaining({ code: "corrupt" }));
    });

    it("when it is given another purpose", () => {
      expect(() => open(ring, { ...binding, purpose: "github-app" }, sealed)).toThrow(expect.objectContaining({ code: "corrupt" }));
    });

    it("when it is truncated, empty or in a format we do not know", () => {
      for (const ciphertext of ["", "v1.", "v1.AAAA", "v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "nonsense", `${sealed.ciphertext}.extra`]) {
        expect(() => open(ring, binding, { ...sealed, ciphertext })).toThrow(expect.objectContaining({ code: "corrupt" }));
      }
    });

    it("without the error saying anything of the credential or the keys", () => {
      let message = "";
      try {
        open(ring, { ...binding, id: "other" }, sealed);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(ring.current.key.toString("hex"));
      expect(message).not.toContain(ring.current.key.toString("base64"));
    });
  });
});

describe("rotating the instance key", () => {
  it("opens under a previous key, and re-wraps under the current one without touching the credential", () => {
    const oldKey = key();
    const before = new Keyring(oldKey);
    const sealed = seal(before, binding, SECRET);

    const after = new Keyring(key(), [oldKey]);
    expect(open(after, binding, sealed)).toBe(SECRET);

    const moved = rewrap(after, binding, sealed);
    expect(moved.kekId).toBe(after.current.id);
    expect(moved.wrappedKey).not.toBe(sealed.wrappedKey);
    const rotated = { ...sealed, ...moved };
    expect(rotated.ciphertext).toBe(sealed.ciphertext);

    // Now the old key is not needed any more.
    const withoutOld = new Keyring(after.current.key);
    expect(open(withoutOld, binding, rotated)).toBe(SECRET);
    expect(() => open(withoutOld, binding, sealed)).toThrow(expect.objectContaining({ code: "unknown_key" }));
  });

  it("cannot re-wrap what its keys cannot open", () => {
    const sealed = seal(new Keyring(key()), binding, SECRET);
    expect(() => rewrap(new Keyring(key()), binding, sealed)).toThrow(expect.objectContaining({ code: "unknown_key" }));
  });
});

describe("a key's fingerprint", () => {
  it("is stable, differs between keys, and is not the key", () => {
    const k = key();
    expect(new Keyring(k).current.id).toBe(new Keyring(Buffer.from(k)).current.id);
    expect(new Keyring(key()).current.id).not.toBe(new Keyring(key()).current.id);
    expect(new Keyring(k).current.id).toMatch(/^[0-9a-f]{16}$/);
    expect(k.toString("hex")).not.toContain(new Keyring(k).current.id);
  });

  it("is how an error names a key", () => {
    const sealed = seal(new Keyring(key()), binding, SECRET);
    try {
      open(new Keyring(key()), binding, sealed);
    } catch (error) {
      expect(isCredentialError(error, "unknown_key")).toBe(true);
      expect((error as Error).message).toContain(sealed.kekId);
    }
  });
});
