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

export type Opened = { ok: true; name: string; text: string } | { ok: false; reason: "wrong_secret" | "damaged" };

/** Open a copy with the key from the link or the password typed. A secret that does not open it, and a copy that is not what a sealed share holds, are told apart. */
export function openShare(module: CryptoModule, input: { mode: SealedMode; ciphertext: string; secret: string }): Opened {
  const secret = encoder.encode(input.secret);
  let plain: Uint8Array;
  try {
    plain = input.mode === "key" ? module.decrypt(fromBase64(input.ciphertext), secret) : module.openWithPassphrase(fromBase64(input.ciphertext), secret);
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
