import { readFileSync } from "node:fs";
import { ConfigError, type Env } from "../db/config";
import { type ReadFile, resolveSecret } from "../secret-env";
import { Keyring, parseKey } from "./keyring";

/**
 * The instance key, from the environment (DESIGN.md §7). Nothing needs it until a repository
 * credential is stored, so it is optional, and when it is not set storing one is refused with a
 * message saying so.
 *
 *   FJORD_ENCRYPTION_KEY[_FILE]            32 random bytes, base64 or hex: `openssl rand -base64 32`.
 *                                          Wraps every credential's own key. Losing it loses every
 *                                          stored credential (they can be connected again), so
 *                                          keep it where backups of the database are not.
 *   FJORD_ENCRYPTION_KEY_PREVIOUS[_FILE]   during a rotation, the key(s) it replaces, separated by
 *                                          commas or newlines. The server wraps everything under
 *                                          the current key when it starts; once it says that
 *                                          nothing remains under an older one, remove this.
 */
export function resolveEncryptionConfig(env: Env = process.env, readFile: ReadFile = (path) => readFileSync(path, "utf8")): Keyring | undefined {
  const current = resolveSecret("FJORD_ENCRYPTION_KEY", env, readFile);
  const previous = resolveSecret("FJORD_ENCRYPTION_KEY_PREVIOUS", env, readFile);
  if (current === undefined) {
    if (previous !== undefined) throw new ConfigError("FJORD_ENCRYPTION_KEY_PREVIOUS is set without FJORD_ENCRYPTION_KEY: the new key is the one that is required.");
    return undefined;
  }
  const bad = "must be 32 random bytes, as base64 or 64 hex characters (openssl rand -base64 32)";
  const currentKey = parseKey(current);
  if (!currentKey) throw new ConfigError(`FJORD_ENCRYPTION_KEY ${bad}.`);
  const previousKeys = (previous ?? "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const key = parseKey(part);
      if (!key) throw new ConfigError(`Each key in FJORD_ENCRYPTION_KEY_PREVIOUS ${bad}.`);
      return key;
    });
  return new Keyring(currentKey, previousKeys);
}

/** What is safe to print about the keys: their fingerprints, never a key. */
export function describeEncryption(keyring: Keyring | undefined): string {
  if (!keyring) return "no instance key set (repository credentials cannot be stored)";
  const previous = keyring.previousIds;
  return `instance key ${keyring.current.id}${previous.length > 0 ? `, previous ${previous.join(", ")}` : ""}`;
}
