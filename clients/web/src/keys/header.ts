import { type Properties, bodyStartOf, propertiesOf } from "../browse/document";
import type { ParsedDocument } from "../format/wasm";
import type { CryptoModule } from "./module";

/**
 * A decrypted document's header and body, in the browser (research 0002, G6). On a plaintext document the server reads the header and rewrites it (`files/http.ts`, `handleHeader`). Here it holds
 * nothing to read, and asking it would be telling it, so the same format module does the same work in the page, and what is typed in the properties goes out only as ciphertext, with the rest of the file.
 */
export type HeaderModule = Pick<CryptoModule, "parseDocument" | "withTitle" | "withDate" | "withTags" | "withField" | "isEntryDate">;

const reader = (module: Pick<CryptoModule, "parseDocument">) => ({ parseDocument: (text: string) => JSON.parse(module.parseDocument(text)) as ParsedDocument });

/** Where a document's body starts and what its header says; null for a text with no header of ours to show, which is edited whole. */
export function splitDocument(module: Pick<CryptoModule, "parseDocument">, text: string): { bodyStart: number; properties: Properties } | null {
  const format = reader(module);
  const bodyStart = bodyStartOf(format, text);
  if (bodyStart === undefined) return null;
  const parsed = format.parseDocument(text);
  return parsed.status === "present" ? { bodyStart, properties: propertiesOf(parsed) } : null;
}

export type HeaderChange = { title: string } | { date: string | null } | { tags: string[] } | { field: { key: string; value: string | boolean | null } };

/** The header with one thing changed, or what to tell the person. The body is not sent in, so nothing of it can be changed. */
export function changeHeader(module: HeaderModule, header: string, change: HeaderChange): { ok: true; header: string; properties: Properties } | { ok: false; message: string } {
  if ("date" in change && change.date !== null && !module.isEntryDate(change.date)) return { ok: false, message: "That is not a date: write it as 2026-11-02, or with a time and an offset, 2026-11-02T08:14:00+05:30." };
  const next =
    "title" in change
      ? module.withTitle(header, change.title)
      : "date" in change
        ? module.withDate(header, change.date ?? undefined)
        : "tags" in change
          ? module.withTags(header, JSON.stringify(change.tags))
          : module.withField(header, change.field.key, JSON.stringify(change.field.value));
  if (next === undefined) return { ok: false, message: "This file's header cannot be read, so it cannot be changed from here." };
  return { ok: true, header: next, properties: propertiesOf(reader(module).parseDocument(next)) };
}
