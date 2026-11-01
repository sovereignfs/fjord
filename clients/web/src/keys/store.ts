import type { CryptoModule } from "./module";

/**
 * The person's age identity in their browser (DESIGN.md §2, ROADMAP 2a.1). It is made or imported here, kept in IndexedDB only as an age
 * **passphrase-sealed** file (`sealWithPassphrase`), and opened into memory when the person types the passphrase. Nothing here is ever sent to
 * the server: the server does not take a key or a passphrase, and this file has no way to reach it.
 *
 *  - **Locked** is the usual state: only the sealed file and the public key (`age1…`, which is not a secret) are there.
 *  - **Unlocked** keeps the secret in memory until `lock()`, a quiet period without use (`IDLE_MS`), or the page going away. Every byte buffer
 *    that held a passphrase or a secret outside that is wiped when it is done with.
 *  - **Never overwritten:** making or importing an identity when one is kept is refused; it has to be removed first. A key that was the only way
 *    into a vault is not lost by a click.
 *  - **The work factor** is 2^17: scrypt needs 128 MB of memory at that (256 MB at age's 2^18, which a phone's browser may refuse) and about 1.7 s;
 *    opening a file made at another factor works, up to the module's limit.
 */
export const WORK_FACTOR = 17;
export const IDLE_MS = 15 * 60 * 1000;
export const MIN_PASSPHRASE_LENGTH = 10;

export interface Stored {
  sealed: Uint8Array;
  /** The `age1…` public key, kept beside the sealed file so that a locked page can show it. */
  recipient: string;
  createdAt: number;
}

export interface Storage {
  get(): Promise<Stored | undefined>;
  put(value: Stored): Promise<void>;
  remove(): Promise<void>;
}

export type Status = { state: "none" } | { state: "locked"; recipient: string } | { state: "unlocked"; recipient: string };

export class KeyError extends Error {
  override name = "KeyError";
  constructor(
    readonly code: "exists" | "weak_passphrase" | "wrong_passphrase" | "not_an_identity" | "none" | "locked" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export interface KeyStoreOptions {
  module: () => Promise<CryptoModule>;
  storage: Storage;
  now?: () => number;
  idleMs?: number;
  /** Told when the identity locks by itself (a quiet period), so a page can say so. */
  onLock?: () => void;
  /** For tests. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const encoder = new TextEncoder();

export class KeyStore {
  private secret: Uint8Array | undefined;
  private recipient: string | undefined;
  private timer: unknown;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: KeyStoreOptions) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async status(): Promise<Status> {
    const stored = await this.options.storage.get();
    if (!stored) return { state: "none" };
    return { state: this.secret ? "unlocked" : "locked", recipient: stored.recipient };
  }

  /** Make a new identity, keep it sealed with the passphrase, and leave it unlocked. */
  async create(passphrase: string): Promise<{ recipient: string }> {
    const module = await this.options.module();
    return this.keep(module, module.generateIdentity(), passphrase);
  }

  /** Keep an identity the person already has: a file's text or a `AGE-SECRET-KEY-1…` line. Only that key is kept, not the file's comments. */
  async import(identityText: string, passphrase: string): Promise<{ recipient: string }> {
    const module = await this.options.module();
    const line = identityText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
    if (!line) throw new KeyError("not_an_identity", "That is not an age secret key. It should contain a line that starts with AGE-SECRET-KEY-1.");
    const secret = encoder.encode(line);
    try {
      module.identityRecipient(secret);
    } catch {
      secret.fill(0);
      throw new KeyError("not_an_identity", "That is not an age secret key. It should contain a line that starts with AGE-SECRET-KEY-1.");
    }
    return this.keep(module, secret, passphrase);
  }

  private async keep(module: CryptoModule, secret: Uint8Array, passphrase: string): Promise<{ recipient: string }> {
    try {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new KeyError("weak_passphrase", `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      if (await this.options.storage.get()) throw new KeyError("exists", "An identity is already kept in this browser. Remove it first if you mean to replace it.");
      const recipient = module.identityRecipient(secret);
      const phrase = encoder.encode(passphrase);
      let sealed: Uint8Array;
      try {
        sealed = module.sealWithPassphrase(secret, phrase, WORK_FACTOR);
      } finally {
        phrase.fill(0);
      }
      await this.options.storage.put({ sealed, recipient, createdAt: this.now() });
      this.unlocked(secret.slice(), recipient);
      return { recipient };
    } finally {
      secret.fill(0);
    }
  }

  async unlock(passphrase: string): Promise<{ recipient: string }> {
    const stored = await this.options.storage.get();
    if (!stored) throw new KeyError("none", "There is no identity kept in this browser.");
    const module = await this.options.module();
    const phrase = encoder.encode(passphrase);
    try {
      const secret = module.openWithPassphrase(stored.sealed, phrase);
      this.unlocked(secret, stored.recipient);
      return { recipient: stored.recipient };
    } catch {
      throw new KeyError("wrong_passphrase", "That passphrase does not open the identity.");
    } finally {
      phrase.fill(0);
    }
  }

  /** Wipe the secret from memory. The sealed file stays. */
  lock(): void {
    this.secret?.fill(0);
    this.secret = undefined;
    this.recipient = undefined;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Forget the identity altogether: the sealed file is deleted, and without a copy of the key, so is the way into what it opened. */
  async remove(): Promise<void> {
    this.lock();
    await this.options.storage.remove();
  }

  /**
   * Run `use` with the secret, and count it as use (the quiet period starts again). The buffer is lent: `use` must not keep it. Locked is an
   * error, so a caller cannot get a key by accident.
   */
  with<T>(use: (secret: Uint8Array) => T): T {
    if (!this.secret) throw new KeyError("locked", "The identity is locked. Enter its passphrase first.");
    this.arm();
    return use(this.secret);
  }

  /** Count as use without the secret, such as typing into a file it opened: a person at work is not a quiet period. Nothing if it is locked. */
  touch(): void {
    if (this.secret) this.arm();
  }

  private unlocked(secret: Uint8Array, recipient: string): void {
    this.secret?.fill(0);
    this.secret = secret;
    this.recipient = recipient;
    this.arm();
  }

  private arm(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.lock();
      this.options.onLock?.();
    }, this.idleMs);
  }
}

/** The identity kept in this browser's IndexedDB: one record, under one key. */
export function indexedDbStorage(name = "fjord-keys"): Storage {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new KeyError("unreadable", "This browser would not open its key storage."));
    });
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = act(db.transaction("identity", mode).objectStore("identity"));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new KeyError("unreadable", "This browser would not read or write its key storage."));
      });
    } finally {
      db.close();
    }
  };
  return {
    get: async () => (await run<Stored | undefined>("readonly", (store) => store.get("main"))) ?? undefined,
    put: async (value) => void (await run("readwrite", (store) => store.put(value, "main"))),
    remove: async () => void (await run("readwrite", (store) => store.delete("main"))),
  };
}
