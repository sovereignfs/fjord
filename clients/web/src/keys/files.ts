import type { CryptoModule } from "./module";
import { KeyError } from "./store";

/**
 * Opening and sealing the text of an encrypted file, in the browser (ROADMAP 2b.2, 2b.3). The module and the lent identity are given, so this is tested with the
 * real module and no page. What it does for the format: an `id`-named vault's file is a `tar` container holding the real name and the contents (spec §6.4), a
 * `plain`-named one is the contents alone; either is age-encrypted to every recipient of the vault.
 *
 * Plaintext buffers are wiped as soon as they are text or ciphertext. The text itself is a string, which a page cannot wipe: that is why a page hides it when it
 * is done and when the identity locks.
 */
export type Shown = { kind: "text"; name: string; text: string } | { kind: "binary"; name: string; bytes: number };

export type Naming = "plain" | "id";

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Decrypt `ciphertext` with the identity `keys` lends, unpack the container of an `id`-named vault, and read the text. */
export function openCiphertext(module: CryptoModule, keys: { with<T>(use: (secret: Uint8Array) => T): T }, ciphertext: Uint8Array, naming: Naming, logical: string): Shown {
  let plain: Uint8Array;
  try {
    plain = keys.with((secret) => module.decrypt(ciphertext, secret));
  } catch (error) {
    if (error instanceof KeyError) throw error;
    throw new KeyError("unreadable", "This identity cannot open the file: it is not one of the keys it was encrypted to, or the file is damaged.");
  }
  let name = logical.slice(logical.lastIndexOf("/") + 1);
  let contents = plain;
  if (naming === "id") {
    try {
      const unwrapped = module.unwrapContainer(plain);
      name = unwrapped.name;
      contents = unwrapped.contents;
    } catch {
      throw new KeyError("unreadable", "The file opened, but what is inside it is not the container the format asks for.");
    } finally {
      plain.fill(0);
    }
  }
  try {
    return { kind: "text", name, text: decoder.decode(contents) };
  } catch {
    return { kind: "binary", name, bytes: contents.byteLength };
  } finally {
    contents.fill(0);
  }
}

/** The ciphertext of `text` for a file called `name`, to every recipient in `recipients` (the text of the vault's recipients file): never to nobody. */
export function sealText(module: CryptoModule, input: { text: string; name: string; naming: Naming; recipients: string }): Uint8Array {
  const contents = encoder.encode(input.text);
  let plain: Uint8Array = contents;
  try {
    if (input.naming === "id") plain = module.wrapContainer(input.name, contents);
    return module.encrypt(plain, input.recipients, false);
  } finally {
    contents.fill(0);
    plain.fill(0);
  }
}

/** Base64 of bytes, as an encrypted draft is kept on the server (`src/working/ciphertext.ts`). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
