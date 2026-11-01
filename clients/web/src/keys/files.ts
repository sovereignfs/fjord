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

/** A moment in the writer's own time zone, to the minute: what a note with nothing to name it by is named after. */
export interface LocalMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type NewFile = { ok: true; ciphertext: string } | { ok: false; reason: "bad_title" };

/**
 * A new note or document in an encrypted vault (ROADMAP 2b.4), written and encrypted here: the server is only given the ciphertext (and, for a vault whose file
 * names are public, the title they are made from). The text and the header are the format module's, as the server's are for a plaintext vault: a note is its title
 * as a heading, or empty; a document has an `id`, a `title` and `created`. In an `id`-named vault the file's real name goes inside the container, made as the
 * format names a file (from the title, else the date and time); it is not numbered, since the folder's other names are secret to this page.
 */
export function newEncryptedFile(
  module: CryptoModule,
  input: { kind: "note" | "document"; title: string; naming: Naming; recipients: string; when: LocalMinute; now: number; random: Uint8Array },
): NewFile {
  const title = input.title.trim();
  const stem = input.kind === "document" ? module.titleFromText(title) : undefined;
  if (input.kind === "document" && !stem) return { ok: false, reason: "bad_title" };
  let text: string;
  let name: string;
  if (input.kind === "note") {
    text = title === "" ? "" : `# ${title}\n`;
    name = module.quickNoteName(text, "[]", input.when.year, input.when.month, input.when.day, input.when.hour, input.when.minute);
  } else {
    const created = module.rfc3339FromUnix(Math.floor(input.now / 1000));
    if (created === undefined) throw new Error("that time cannot be written as a date");
    text = module.newDocument(module.newUlid(input.now, input.random), title, created);
    name = module.freeName(stem as string, ".fj.md", "[]");
  }
  return { ok: true, ciphertext: toBase64(sealText(module, { text, name, naming: input.naming, recipients: input.recipients })) };
}

/** Where a file can be moved to in another vault (ROADMAP 2b.6): a plaintext vault, or an encrypted one with the recipients to encrypt to (or why there is none). */
export type TransferForm = { form: "plaintext" } | { form: "encrypted"; naming: Naming };

/** The text of a vault's recipients file, or why there is none. */
export type Recipients = { ok: true; text: string } | { ok: false; message: string };

export interface TransferTarget {
  /** The folder it goes into, repository-relative; a vault's own directory is its top. */
  folder: string;
  vault: string;
  to: TransferForm;
}

/**
 * The file as the destination vault holds it (ROADMAP 2b.6), made here because the server has no key: the text itself for a plaintext vault; for an encrypted one the
 * ciphertext (with its real name inside a container in an `id`-named vault, whose file is then called by a new identifier, else by its name and `.age`). `leaf` is the
 * name in the folder. The server holds the destination to the form it holds, so this cannot put plain text in an encrypted vault even if it were wrong.
 */
export function prepareTransfer(
  module: CryptoModule,
  input: { text: string; name: string; to: TransferForm; recipients?: Recipients | undefined; now: number; random: Uint8Array },
): { ok: true; leaf: string; content: string } | { ok: false; message: string } {
  if (input.to.form === "plaintext") return { ok: true, leaf: input.name, content: toBase64(encoder.encode(input.text)) };
  if (!input.recipients?.ok) return { ok: false, message: input.recipients?.message ?? "The vault's recipients were not read, so there is no one to encrypt to." };
  const sealed = toBase64(sealText(module, { text: input.text, name: input.name, naming: input.to.naming, recipients: input.recipients.text }));
  return { ok: true, leaf: input.to.naming === "id" ? `${module.newUlid(input.now, input.random)}.age` : `${input.name}.age`, content: sealed };
}
