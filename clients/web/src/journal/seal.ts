import type { CryptoModule } from "../keys/module";
import { sealText, toBase64 } from "../keys/files";

/**
 * A new entry of an **encrypted** journal, written and encrypted here (ROADMAP 3b.1, spec §11.2): the format module dates it at this browser's
 * offset, writes its header, and names it as an encrypted journal names its entries, flat and with no dated folder. That name goes inside the
 * container; the server is given only the ciphertext and names the file by a new identifier, so nothing of the entry's date or title leaves the page.
 */
export function newEncryptedEntry(module: CryptoModule, input: { title: string; recipients: string; now: Date; random: Uint8Array }): { ciphertext: string; date: string } {
  const seconds = Math.floor(input.now.getTime() / 1000);
  const date = module.entryDateFromUnix(seconds, -input.now.getTimezoneOffset());
  const created = module.rfc3339FromUnix(seconds);
  if (date === undefined || created === undefined) throw new Error("that time cannot be written as a date");
  const title = input.title.trim();
  const name = module.journalEntryPath(date, title === "" ? undefined : module.journalSlug(title), true);
  if (name === undefined) throw new Error("that date names no entry");
  const text = module.newEntry(module.newUlid(input.now.getTime(), input.random), title === "" ? undefined : title, created, date);
  return { ciphertext: toBase64(sealText(module, { text, name, naming: "id", recipients: input.recipients })), date };
}
