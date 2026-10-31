import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wasmAvailable, wasmDirectory } from "../format/wasm";
import type { CryptoModule } from "./module";
import { IDLE_MS, KeyError, KeyStore, type Stored, type Storage, WORK_FACTOR } from "./store";

/**
 * The identity in the browser (ROADMAP 2a.1), with the real module (the one the server loads, whose functions are the page's) and a storage in memory.
 * What the page's IndexedDB adds is checked in a browser (`e2e/keys.open.spec.ts`).
 */
const available = wasmAvailable();
if (!available && process.env.CI) throw new Error(`the format module is not built at ${wasmDirectory()}: run pnpm build:wasm before the tests`);

const PASSPHRASE = "a passphrase of some length";

function memory(): Storage & { value: Stored | undefined } {
  const holder: { value: Stored | undefined } = { value: undefined };
  return {
    get value() {
      return holder.value;
    },
    get: async () => holder.value,
    put: async (value) => void (holder.value = value),
    remove: async () => void (holder.value = undefined),
  } as Storage & { value: Stored | undefined };
}

function make(options: { idleMs?: number; onLock?: () => void } = {}) {
  const real = createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as CryptoModule;
  // The sealing is made cheap for the tests, except where a test asks what the real work factor is.
  const seen: number[] = [];
  const module: CryptoModule = { ...real, sealWithPassphrase: (plain, phrase, logN) => (seen.push(logN), real.sealWithPassphrase(plain, phrase, 10)) } as CryptoModule;
  const storage = memory();
  const store = new KeyStore({ module: async () => module, storage, ...options });
  return { store, storage, real, seen };
}

const refused = async (promise: Promise<unknown>, code: KeyError["code"]) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(KeyError);
  expect((error as KeyError).code).toBe(code);
  return error as KeyError;
};

afterEach(() => vi.useRealTimers());

describe.skipIf(!available)("the identity kept in a browser", () => {
  it("has none to begin with", async () => {
    expect(await make().store.status()).toEqual({ state: "none" });
  });

  it("is made, sealed with the passphrase at the work factor the page chose, and left unlocked", async () => {
    const { store, storage, seen } = make();
    const { recipient } = await store.create(PASSPHRASE);
    expect(recipient).toMatch(/^age1/);
    expect(seen).toEqual([WORK_FACTOR]);
    expect(await store.status()).toEqual({ state: "unlocked", recipient });
    expect(storage.value?.recipient).toBe(recipient);
    // What is kept is sealed: it holds neither the secret nor the passphrase.
    const kept = Buffer.from(storage.value!.sealed).toString("latin1");
    store.with((secret) => expect(kept).not.toContain(Buffer.from(secret).toString("latin1").slice(0, 20)));
    expect(kept).not.toContain(PASSPHRASE);
  });

  it("is locked by lock(), shows its public key, and is opened again only by the passphrase", async () => {
    const { store } = make();
    const { recipient } = await store.create(PASSPHRASE);
    store.lock();
    expect(await store.status()).toEqual({ state: "locked", recipient });
    expect(() => store.with(() => 1)).toThrow(KeyError);
    await refused(store.unlock("another passphrase"), "wrong_passphrase");
    expect(await store.status()).toEqual({ state: "locked", recipient });
    expect(await store.unlock(PASSPHRASE)).toEqual({ recipient });
    expect(store.with((secret) => new TextDecoder().decode(secret).startsWith("AGE-SECRET-KEY-1"))).toBe(true);
  });

  it("lends the secret and uses it: what is encrypted to its public key is read with it", async () => {
    const { store, real } = make();
    const { recipient } = await store.create(PASSPHRASE);
    const sealed = real.encrypt(new TextEncoder().encode("a document"), recipient, false);
    expect(new TextDecoder().decode(store.with((secret) => real.decrypt(sealed, secret)))).toBe("a document");
  });

  it("wipes the secret on lock: a buffer that was lent is zeroes afterwards", async () => {
    const { store } = make();
    await store.create(PASSPHRASE);
    let lent!: Uint8Array;
    store.with((secret) => void (lent = secret));
    expect(lent.some((byte) => byte !== 0)).toBe(true);
    store.lock();
    expect([...lent].every((byte) => byte === 0)).toBe(true);
  });

  it("locks itself after a quiet period, which every use puts off, and says so", async () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const { store } = make({ onLock });
    await store.create(PASSPHRASE);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    store.with(() => undefined);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect((await store.status()).state).toBe("unlocked");
    expect(onLock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await store.status()).state).toBe("locked");
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("takes an identity the person has, from a file's text or a bare line, and keeps only the key", async () => {
    const { store, storage, real } = make();
    const secret = new TextDecoder().decode(real.generateIdentity());
    const recipient = real.identityRecipient(new TextEncoder().encode(secret));
    const file = `# created: today\n# public key: ${recipient}\n${secret}\n`;
    expect(await store.import(file, PASSPHRASE)).toEqual({ recipient });
    store.lock();
    await store.unlock(PASSPHRASE);
    store.with((kept) => expect(new TextDecoder().decode(kept)).toBe(secret));
    expect(storage.value?.recipient).toBe(recipient);

    const other = make();
    expect(await other.store.import(secret, PASSPHRASE)).toEqual({ recipient });
  });

  it("refuses what is not an identity, and a passphrase that is too short, and keeps nothing", async () => {
    const { store, storage } = make();
    await refused(store.import("hello", PASSPHRASE), "not_an_identity");
    await refused(store.import("AGE-SECRET-KEY-1NOTAKEY", PASSPHRASE), "not_an_identity");
    await refused(store.create("short"), "weak_passphrase");
    expect(storage.value).toBeUndefined();
    expect(await store.status()).toEqual({ state: "none" });
  });

  it("does not replace an identity that is kept, and removing it is how", async () => {
    const { store, storage } = make();
    const first = await store.create(PASSPHRASE);
    await refused(store.create(PASSPHRASE), "exists");
    expect(storage.value?.recipient).toBe(first.recipient);
    await store.remove();
    expect(await store.status()).toEqual({ state: "none" });
    expect(() => store.with(() => 1)).toThrow(KeyError);
    expect((await store.create(PASSPHRASE)).recipient).not.toBe(first.recipient);
  });

  it("will not unlock what is not there", async () => {
    await refused(make().store.unlock(PASSPHRASE), "none");
  });
});
