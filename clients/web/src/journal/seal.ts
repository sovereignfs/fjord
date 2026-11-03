import type { CryptoModule } from "../keys/module";
import { sealText, toBase64 } from "../keys/files";

/**
 * A new entry of an **encrypted** journal, written and encrypted here (ROADMAP 3b.1, spec §11.2): the format module dates it at this browser's
 * offset, writes its header, and names it as a journal names its entries, `YYYY-MM-DD/hh-mm.md`. The minute (`hh-mm.md`) is the name inside the container; the server is
 * given the ciphertext and the day's folder, and names the file by a new identifier. **The day is public** (a directory name is never encrypted, and
 * the owner chose that, workstream 0003): the time, the title and the text are not.
 */
export function newEncryptedEntry(module: CryptoModule, input: { title: string; recipients: string; now: Date; random: Uint8Array }): { ciphertext: string; date: string; folder: string } {
  const seconds = Math.floor(input.now.getTime() / 1000);
  const date = module.entryDateFromUnix(seconds, -input.now.getTimezoneOffset());
  const created = module.rfc3339FromUnix(seconds);
  if (date === undefined || created === undefined) throw new Error("that time cannot be written as a date");
  const title = input.title.trim();
  const path = module.journalEntryPath(date);
  if (path === undefined) throw new Error("that date names no entry");
  // A container's entry name is a plain file name (spec §6.4): the minute; the day is the folder it is filed in.
  const folder = path.slice(0, path.indexOf("/"));
  const name = path.slice(folder.length + 1);
  const text = module.newEntry(module.newUlid(input.now.getTime(), input.random), title === "" ? undefined : title, created, date);
  return { ciphertext: toBase64(sealText(module, { text, name, naming: "id", recipients: input.recipients })), date, folder };
}
