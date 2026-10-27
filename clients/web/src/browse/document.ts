import type { Fjord } from "../format/wasm";

/**
 * Where a document's body starts in its text (DESIGN.md §9, ROADMAP 1b.3). A document is a header (`---` … `---`, written and
 * kept by `fjord-core`) and a body of Markdown, and the editor is given the body only: the header is not the editor's, so it
 * cannot be rewritten by it. The module says where the body starts as a byte offset (it is Rust's); this is that as a place
 * in a JavaScript string, which is what slicing the text takes.
 *
 * A file with no header is all body. A header that cannot be read (it is not closed, or is not a mapping, or is not YAML) is
 * not ours to split or to rewrite, so there is no answer: the file is then shown as Markdown whole, byte for byte.
 */
export function bodyStartOf(format: Pick<Fjord, "parseDocument">, text: string): number | undefined {
  const parsed = format.parseDocument(text);
  // A `---` further down is a rule in the body, not a header.
  if (parsed.status === "absent" || parsed.status === "notAtStart") return 0;
  if (parsed.status !== "present" || typeof parsed.bodyOffset !== "number") return undefined;
  const bytes = new TextEncoder().encode(text);
  if (parsed.bodyOffset > bytes.length) return undefined;
  // The header ends at a line break, so these bytes are whole characters.
  return new TextDecoder("utf-8").decode(bytes.subarray(0, parsed.bodyOffset)).length;
}

/** A header's keys as the Document properties panel shows them (ROADMAP 1b.5). */
export interface Properties {
  id: string | null;
  title: string | null;
  created: string | null;
  /** Every other key, in the order written, with its value as text: Fjord shows what it does not know and keeps it. */
  others: { key: string; value: string }[];
}

/**
 * A note or a document's header, for the page (DESIGN.md §9, ROADMAP 1b.5): where the body starts, and either the header's
 * properties or, when there is no header, the one that is put in front of the body the first time the person edits it
 * (promotion, spec §8.1: never because a file was merely scanned) with the properties it gives. The promoted header is made
 * here, by the module, with the time and the randomness of now; it is the whole of the new text before the body, so the body
 * is never touched.
 *
 * A text with a carriage return in it or a byte order mark at its start is not promoted: a header of our own would mix its line
 * endings with the file's, or move the mark off the first byte. It stays as it is, which the spec allows (§8.1).
 *
 * Undefined for a header that cannot be read: it is not ours to split or rewrite, and the file is shown whole.
 */
export interface HeaderInfo {
  bodyStart: number;
  properties?: Properties;
  promotion?: { header: string; properties: Properties };
}

const KNOWN = new Set(["id", "title", "created"]);

type Reader = Pick<Fjord, "parseDocument">;

function propertiesOf(parsed: ReturnType<Reader["parseDocument"]>): Properties {
  const raw = parsed.frontmatter ?? {};
  return {
    id: parsed.docId ?? null,
    title: typeof raw.title === "string" ? raw.title : null,
    created: typeof raw.created === "string" ? raw.created : null,
    others: Object.entries(raw)
      .filter(([key]) => !KNOWN.has(key))
      .map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) })),
  };
}

export function headerOf(
  format: Reader & Pick<Fjord, "promoteDocument" | "impliedTitle" | "newUlid" | "rfc3339FromUnix">,
  text: string,
  fileName: string,
  now: number = Date.now(),
  random: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(16)),
): HeaderInfo | undefined {
  const bodyStart = bodyStartOf(format, text);
  if (bodyStart === undefined) return undefined;
  const parsed = format.parseDocument(text);
  if (parsed.status === "present") return { bodyStart, properties: propertiesOf(parsed) };
  if (text.includes("\r") || text.startsWith("\uFEFF")) return { bodyStart };
  const header = format.promoteDocument("", format.newUlid(now, random), format.rfc3339FromUnix(Math.floor(now / 1000)), format.impliedTitle(text, fileName));
  return header === undefined ? { bodyStart } : { bodyStart, promotion: { header, properties: propertiesOf(format.parseDocument(header)) } };
}
