import { ConfigError } from "../db/config";
import { getDatabase } from "../db/boot";
import { resolveEncryptionConfig } from "./config";
import { CredentialStore } from "./store";
import type { Keyring } from "./keyring";

/**
 * The server's credential store, for routes and the worker (never for a test, which builds one
 * from a keyring it chose). The key is read once, so a bad one is reported at start-up
 * (`instrumentation.ts`) and not on the first person to connect a repository.
 */
const KEY = Symbol.for("fjord.encryption");
type Holder = { [KEY]?: { keyring: Keyring | undefined } };

function holder(): NonNullable<Holder[typeof KEY]> {
  const store = globalThis as Holder;
  store[KEY] ??= { keyring: resolveEncryptionConfig(process.env) };
  return store[KEY];
}

/** The instance's keys, or undefined when none is configured. */
export function encryptionKeyring(): Keyring | undefined {
  return holder().keyring;
}

/** The credential store, or a `ConfigError` saying a key is needed. */
export async function credentialStore(): Promise<CredentialStore> {
  const keyring = holder().keyring;
  if (!keyring) throw new ConfigError("FJORD_ENCRYPTION_KEY (or _FILE) is required to store a repository credential (openssl rand -base64 32).");
  return new CredentialStore(await getDatabase(), keyring);
}
