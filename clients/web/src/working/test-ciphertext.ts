import { createRequire } from "node:module";
import { join } from "node:path";
import { wasmDirectory } from "../format/wasm";

/** For tests of encrypted drafts (ROADMAP 2b.3): real age ciphertext, made by the same module the browser uses, to a recipient made here. */
interface Crypto {
  generateIdentity(): Uint8Array;
  identityRecipient(identity: Uint8Array): string;
  encrypt(plaintext: Uint8Array, recipients: string, armor: boolean): Uint8Array;
}

const load = () => createRequire(import.meta.url)(join(wasmDirectory(), "fjord_wasm.js")) as Crypto;

/** A recipients file's text with one new recipient in it; the identity it belongs to is thrown away. */
export function newRecipients(): string {
  const module = load();
  const identity = module.generateIdentity();
  const recipient = module.identityRecipient(identity);
  identity.fill(0);
  return `${recipient}\n`;
}

/** The ciphertext of `text`, to a recipient of its own (or to `recipients`), as the base64 an encrypted draft is kept as, and as bytes. */
export function encryptedDraft(text: string, recipients: string = newRecipients()): { content: string; bytes: Uint8Array } {
  const bytes = load().encrypt(new TextEncoder().encode(text), recipients, false);
  return { content: Buffer.from(bytes).toString("base64"), bytes };
}
