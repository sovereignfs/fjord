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
