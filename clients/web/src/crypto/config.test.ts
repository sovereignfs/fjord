import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../db/config";
import { describeEncryption, resolveEncryptionConfig } from "./config";

const b64 = () => randomBytes(32).toString("base64");
const hex = () => randomBytes(32).toString("hex");

describe("resolveEncryptionConfig", () => {
  it("is off when no key is set, and nothing else is read", () => {
    expect(resolveEncryptionConfig({})).toBeUndefined();
    expect(resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: "" })).toBeUndefined();
  });

  it("takes a key as base64, base64url or hex", () => {
    const bytes = randomBytes(32);
    const ids = [bytes.toString("base64"), bytes.toString("base64url"), bytes.toString("hex")].map((k) => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: k })?.current.id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("takes a key from a file, as a container secret, with its trailing newline", () => {
    const k = b64();
    const ring = resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY_FILE: "/run/secrets/key" }, () => `${k}\n`);
    expect(ring?.current.id).toBe(resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: k })?.current.id);
    expect(() => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: k, FJORD_ENCRYPTION_KEY_FILE: "/x" }, () => k)).toThrow(/not both/);
  });

  it("refuses a key that is too short, too long or not a key, without printing it", () => {
    for (const bad of ["short", randomBytes(16).toString("base64"), randomBytes(48).toString("base64"), "not base64 at all!!", `${hex()}ab`]) {
      const attempt = () => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: bad });
      expect(attempt).toThrow(ConfigError);
      expect(attempt).toThrow(/32 random bytes/);
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).not.toContain(bad);
      }
    }
  });

  it("takes previous keys, separated by commas or newlines, for a rotation", () => {
    const [a, b] = [b64(), hex()];
    const ring = resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: b64(), FJORD_ENCRYPTION_KEY_PREVIOUS: `${a}, ${b}` });
    expect(ring?.previousIds).toHaveLength(2);
    const fromFile = resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: b64(), FJORD_ENCRYPTION_KEY_PREVIOUS_FILE: "/p" }, () => `${a}\n${b}\n`);
    expect(fromFile?.previousIds).toHaveLength(2);
  });

  it("refuses previous keys without a current one, a bad previous one, and a key given twice", () => {
    expect(() => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY_PREVIOUS: b64() })).toThrow(/without FJORD_ENCRYPTION_KEY/);
    expect(() => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: b64(), FJORD_ENCRYPTION_KEY_PREVIOUS: "nope" })).toThrow(/FJORD_ENCRYPTION_KEY_PREVIOUS/);
    const same = b64();
    expect(() => resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: same, FJORD_ENCRYPTION_KEY_PREVIOUS: same })).toThrow(/twice/);
  });
});

describe("describeEncryption", () => {
  it("prints fingerprints and never a key", () => {
    const current = b64();
    const previous = b64();
    const text = describeEncryption(resolveEncryptionConfig({ FJORD_ENCRYPTION_KEY: current, FJORD_ENCRYPTION_KEY_PREVIOUS: previous }));
    expect(text).toMatch(/instance key [0-9a-f]{16}, previous [0-9a-f]{16}/);
    expect(text).not.toContain(current);
    expect(text).not.toContain(previous);
  });

  it("says when there is no key", () => {
    expect(describeEncryption(undefined)).toMatch(/no instance key/);
  });
});
