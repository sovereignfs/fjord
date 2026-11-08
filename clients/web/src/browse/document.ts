import type { Fjord } from '../format/wasm';

/**
 * Where a document's body starts in its text (DESIGN.md §9, ROADMAP 1b.3). A document is a header (`---` … `---`, written and
 * kept by `fjord-core`) and a body of Markdown, and the editor is given the body only: the header is not the editor's, so it
 * cannot be rewritten by it. The module says where the body starts as a byte offset (it is Rust's); this is that as a place
 * in a JavaScript string, which is what slicing the text takes.
 *
 * A file with no header is all body. A header that cannot be read (it is not closed, or is not a mapping, or is not YAML) is
 * not ours to split or to rewrite, so there is no answer: the file is then shown as Markdown whole, byte for byte.
 */
export function bodyStartOf(
  format: Pick<Fjord, 'parseDocument'>,
  text: string,
): number | undefined {
  const parsed = format.parseDocument(text);
  // A `---` further down is a rule in the body, not a header.
  if (parsed.status === 'absent' || parsed.status === 'notAtStart') return 0;
  if (parsed.status !== 'present' || typeof parsed.bodyOffset !== 'number') return undefined;
  const bytes = new TextEncoder().encode(text);
  if (parsed.bodyOffset > bytes.length) return undefined;
  // The header ends at a line break, so these bytes are whole characters.
  return new TextDecoder('utf-8').decode(bytes.subarray(0, parsed.bodyOffset)).length;
}

/** A header's keys as the Document properties panel shows them (ROADMAP 1b.5). */
export interface Properties {
  id: string | null;
  title: string | null;
  created: string | null;
  /** `date`, when it is text: the moment the Doc is about, with the writer's offset (spec §8.1). A `date` that is not text is among `others`. */
  date: string | null;
  /** `tags`, when they are a list of text, as written (spec §8.1). Tags of another shape are among `others`. */
  tags: string[] | null;
  /** `draft`, when it is a yes or no (a site's post, RFC 0002). Another shape is among `others`. */
  draft: boolean | null;
  /** `description`, when it is text. Another shape is among `others`. */
  description: string | null;
  /** Every other key, in the order written, with its value as text: Fjord shows what it does not know and keeps it. `editable` says whether a form can set it: text or a yes or no. */
  others: { key: string; value: string; editable?: 'text' | 'flag' }[];
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

const KNOWN = new Set(['id', 'title', 'created']);

type Reader = Pick<Fjord, 'parseDocument'>;

export function propertiesOf(parsed: ReturnType<Reader['parseDocument']>): Properties {
  const raw = parsed.frontmatter ?? {};
  return {
    id: parsed.docId ?? null,
    title: typeof raw.title === 'string' ? raw.title : null,
    created: typeof raw.created === 'string' ? raw.created : null,
    date: typeof raw.date === 'string' ? raw.date : null,
    tags: tagList(raw.tags),
    draft: typeof raw.draft === 'boolean' ? raw.draft : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    others: Object.entries(raw)
      .filter(
        ([key, value]) =>
          !KNOWN.has(key) &&
          !(key === 'date' && typeof value === 'string') &&
          !(key === 'tags' && tagList(value) !== null) &&
          !(key === 'draft' && typeof value === 'boolean') &&
          !(key === 'description' && typeof value === 'string'),
      )
      .map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        ...(typeof value === 'string'
          ? { editable: 'text' as const }
          : typeof value === 'boolean'
            ? { editable: 'flag' as const }
            : {}),
      })),
  };
}

/** `tags` as a list of text, or null for anything else (a string, a list with something that is not text in it). */
function tagList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string')
    ? (value as string[])
    : null;
}

export function headerOf(
  format: Reader & Pick<Fjord, 'promoteDocument' | 'impliedTitle' | 'newUlid' | 'rfc3339FromUnix'>,
  text: string,
  fileName: string,
  now: number = Date.now(),
  random: Uint8Array = globalThis.crypto.getRandomValues(new Uint8Array(16)),
): HeaderInfo | undefined {
  const bodyStart = bodyStartOf(format, text);
  if (bodyStart === undefined) return undefined;
  const parsed = format.parseDocument(text);
  if (parsed.status === 'present') return { bodyStart, properties: propertiesOf(parsed) };
  if (text.includes('\r') || text.startsWith('\uFEFF')) return { bodyStart };
  const header = format.promoteDocument(
    '',
    format.newUlid(now, random),
    format.rfc3339FromUnix(Math.floor(now / 1000)),
    format.impliedTitle(text, fileName),
  );
  return header === undefined
    ? { bodyStart }
    : { bodyStart, promotion: { header, properties: propertiesOf(format.parseDocument(header)) } };
}

/** A file's name as a person calls it: without `.md`, or `.fj.md`, which are for Fjord and not for them. */
export function stemOf(fileName: string): string {
  return fileName.replace(/(\.fj)?\.md$/i, '');
}

/**
 * What a document is called, at the head of its page: the title its header gives it, else the first level-one heading of its body (`# Title`, outside a code block), else its
 * file's name without the extension. The text is the one shown (a draft, if there is one), and `bodyStart` where its body begins in it.
 */
export function documentTitle(
  text: string,
  bodyStart: number | undefined,
  headerTitle: string | null | undefined,
  fileName: string,
): string {
  const fromHeader = headerTitle?.trim();
  if (fromHeader) return fromHeader;
  let fenced: string | null = null;
  for (const line of text.slice(bodyStart ?? 0).split(/\r?\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const mark = fence[1]!;
      if (fenced === null) fenced = mark[0]!;
      else if (mark[0] === fenced) fenced = null;
      continue;
    }
    if (fenced !== null) continue;
    const heading = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading?.[1] && heading[1].trim() !== '') return heading[1].trim();
  }
  return stemOf(fileName);
}
