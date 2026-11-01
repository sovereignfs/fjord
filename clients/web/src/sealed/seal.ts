import { fromBase64, toBase64 } from "../keys/files";
import type { CryptoModule } from "../keys/module";
import { MIN_PASSPHRASE_LENGTH, WORK_FACTOR } from "../keys/store";
import type { SealedMode } from "./service";

/**
 * Making and opening a sealed copy, in the browser (ROADMAP 2c.1). The server has no key, so the sharer's page seals the document: its text and its name, as a small JSON
 * document, encrypted either **to a one-use age key made for this share** (`key`: the secret is returned to be put in the link's `#fragment`, which no request carries, and
 * is kept nowhere else) or **to a password** (`password`: age's scrypt, as slow as the identity's passphrase, so guessing it is slow too). The viewer's page opens it with
 * the key from the fragment or the password typed. The module and the buffers are the identity's (`src/keys/`): every secret buffer is wiped when it is done with.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const KEY_FORM = /^AGE-SECRET-KEY-1[A-Z0-9]+$/;

export type Sealed = { mode: "key"; ciphertext: string; key: string } | { mode: "password"; ciphertext: string };

/** The address's fragment that carries a key: `#key=AGE-SECRET-KEY-1…`. */
export const keyFragment = (key: string) => `#key=${key}`;

/** The key a fragment carries, if it carries one. */
export function keyFromFragment(fragment: string): string | undefined {
  const match = /^#key=(.+)$/.exec(fragment);
  return match && KEY_FORM.test(match[1] as string) ? (match[1] as string) : undefined;
}

export function sealShare(module: CryptoModule, input: { name: string; text: string } & ({ mode: "key" } | { mode: "password"; password: string })): Sealed {
  const payload = encoder.encode(JSON.stringify({ v: 1, name: input.name, text: input.text }));
  try {
    if (input.mode === "key") {
      const identity = module.generateIdentity();
      try {
        const recipient = module.identityRecipient(identity);
        return { mode: "key", ciphertext: toBase64(module.encrypt(payload, `${recipient}\n`, false)), key: decoder.decode(identity) };
      } finally {
        identity.fill(0);
      }
    }
    if (input.password.length < MIN_PASSPHRASE_LENGTH) throw new Error(`a password is at least ${MIN_PASSPHRASE_LENGTH} characters`);
    const password = encoder.encode(input.password);
    try {
      return { mode: "password", ciphertext: toBase64(module.sealWithPassphrase(payload, password, WORK_FACTOR)) };
    } finally {
      password.fill(0);
    }
  } finally {
    payload.fill(0);
  }
}

/**
 * The most work a password-sealed copy may ask of the opener (security review of phase 2). The copy comes from whoever made the link, and the work factor is written in
 * its header: a copy that asked for 2^20 would hold the viewer's tab for many seconds and a gigabyte of memory before it said the password was wrong. Ours are 2^17 (the
 * identity's); age's own default, 2^18, is the most that is accepted. The header is read before any work is done.
 */
export const MAX_SHARED_WORK_FACTOR = 18;

/** The work factor (log2 of scrypt's N) an age file asks of the one who opens it, read from its header; undefined if it has no password stanza. */
export function scryptWorkFactor(bytes: Uint8Array): number | undefined {
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  const match = /^-> scrypt \S+ (\d+)$/m.exec(header);
  return match ? Number(match[1]) : undefined;
}

export type Opened = { ok: true; name: string; text: string } | { ok: false; reason: "wrong_secret" | "damaged" | "too_costly" };

/** Open a copy with the key from the link or the password typed. A secret that does not open it, and a copy that is not what a sealed share holds, are told apart. */
export function openShare(module: CryptoModule, input: { mode: SealedMode; ciphertext: string; secret: string }): Opened {
  const copy = fromBase64(input.ciphertext);
  if (input.mode === "password") {
    const cost = scryptWorkFactor(copy);
    if (cost === undefined || cost > MAX_SHARED_WORK_FACTOR) return { ok: false, reason: cost === undefined ? "damaged" : "too_costly" };
  }
  const secret = encoder.encode(input.secret);
  let plain: Uint8Array;
  try {
    plain = input.mode === "key" ? module.decrypt(copy, secret) : module.openWithPassphrase(copy, secret);
  } catch {
    return { ok: false, reason: "wrong_secret" };
  } finally {
    secret.fill(0);
  }
  try {
    const parsed = JSON.parse(decoder.decode(plain)) as { v?: unknown; name?: unknown; text?: unknown };
    if (parsed.v !== 1 || typeof parsed.name !== "string" || typeof parsed.text !== "string") return { ok: false, reason: "damaged" };
    return { ok: true, name: parsed.name, text: parsed.text };
  } catch {
    return { ok: false, reason: "damaged" };
  } finally {
    plain.fill(0);
  }
}
