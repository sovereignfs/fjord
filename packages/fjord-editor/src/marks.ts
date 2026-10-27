// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { TextQuoteAnchor } from "./types.js";

/**
 * Marking comment threads in the text (ROADMAP 1d.1, clients/web/DESIGN.md §13). A thread is shown as a highlight over the text it is
 * about, and a click on the text finds which thread it belongs to.
 *
 * The highlight is drawn with the browser's **CSS Custom Highlight API** over ranges of the rendered text, not with nodes in the
 * editor's own document. So a mark is never part of what is edited, saved or compared with the Markdown, cannot be lost by an edit
 * or carried into the file, and the same code marks a document that can be edited and one that is only read. Where the browser has
 * no such API nothing is drawn: the thread is in the app's panel all the same. The ranges are found again from each thread's
 * text-quote anchor whenever the threads or the text change, which is what lets a mark follow the text it is about.
 */
export interface MarkedThread {
  id: string;
  anchor: TextQuoteAnchor;
  resolved: boolean;
}

/** The names the highlights are registered under; the stylesheet colours them (`::highlight(fe-thread)`). */
export const HIGHLIGHTS = { open: "fe-thread", resolved: "fe-thread-resolved", active: "fe-thread-active" } as const;

const BLOCKS = /^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|PRE|DIV|TR|UL|OL|TABLE|HR)$/;

interface Segment {
  node: Text;
  /** Where this text node starts in the flattened text. */
  start: number;
}

/** The text of `root` as one string, with a line break wherever a block begins, and where in it each text node is. */
export function flatten(root: Node): { text: string; segments: Segment[] } {
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const segments: Segment[] = [];
  let text = "";
  let block: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const here = blockOf(node, root);
    if (block !== null && here !== block && text !== "" && !text.endsWith("\n")) text += "\n";
    block = here;
    segments.push({ node, start: text.length });
    text += node.data;
  }
  return { text, segments };
}

function blockOf(node: Node, root: Node): Element | null {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (BLOCKS.test(element.tagName)) return element;
  }
  return null;
}

/** How many characters at the end of `a` equal those at the end of `b`. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** How many characters at the start of `a` equal those at the start of `b`. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where a thread's quote is in `text`: the place whose surroundings are most like the anchor's, nearest the hint on a tie, or `undefined`
 * if the quote is not there at all. (A text that has changed under a thread is the app's to re-anchor, ROADMAP 1d.2; this only finds
 * what is still there, exactly.)
 */
export function locate(text: string, anchor: TextQuoteAnchor): number | undefined {
  if (anchor.quote === "") return undefined;
  let best: { at: number; score: number; distance: number } | undefined;
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    const before = text.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = text.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length);
    const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    const distance = Math.abs(at - anchor.position);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { at, score, distance };
  }
  return best?.at;
}

/** The range of text a thread marks in `root`, for each thread whose quote is found. */
export function rangesFor(root: Node, threads: readonly MarkedThread[]): Map<string, Range> {
  const { text, segments } = flatten(root);
  const out = new Map<string, Range>();
  if (segments.length === 0) return out;
  const position = (offset: number, preferEnd: boolean): [Text, number] => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]!;
      const end = segment.start + segment.node.data.length;
      if (offset >= segment.start && (offset < end || (preferEnd && offset === end))) return [segment.node, offset - segment.start];
    }
    const last = segments[segments.length - 1]!;
    return [last.node, last.node.data.length];
  };
  for (const thread of threads) {
    const at = locate(text, thread.anchor);
    if (at === undefined) continue;
    const range = root.ownerDocument!.createRange();
    const [startNode, startOffset] = position(at, false);
    const [endNode, endOffset] = position(at + thread.anchor.quote.length, true);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    out.set(thread.id, range);
  }
  return out;
}

/** What the browser offers for drawing highlights: a registry by name, and a way to make one from ranges. */
export interface HighlightApi {
  registry: { set(name: string, highlight: unknown): unknown; delete(name: string): unknown };
  make(...ranges: Range[]): unknown;
}

/** The browser's own, if it has them. */
export function browserHighlights(): HighlightApi | undefined {
  const css = (globalThis as { CSS?: { highlights?: HighlightApi["registry"] } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || !Highlight) return undefined;
  return { registry: css.highlights, make: (...ranges) => new Highlight(...ranges) };
}

/**
 * Draw the threads' marks: the open ones, the resolved ones more faintly, and the one being looked at over both. Returns how to take them
 * off, and the ranges that were found (by thread), for finding which one a click was on.
 */
export function paintMarks(root: Node, threads: readonly MarkedThread[], activeId: string | null, api: HighlightApi | undefined = browserHighlights()): { ranges: Map<string, Range>; clear: () => void } {
  const ranges = rangesFor(root, threads);
  const clear = () => {
    for (const name of Object.values(HIGHLIGHTS)) api?.registry.delete(name);
  };
  if (!api) return { ranges, clear };
  clear();
  const open = threads.filter((thread) => !thread.resolved && ranges.has(thread.id)).map((thread) => ranges.get(thread.id)!);
  const resolved = threads.filter((thread) => thread.resolved && ranges.has(thread.id)).map((thread) => ranges.get(thread.id)!);
  const active = activeId !== null && ranges.has(activeId) ? [ranges.get(activeId)!] : [];
  if (open.length > 0) api.registry.set(HIGHLIGHTS.open, api.make(...open));
  if (resolved.length > 0) api.registry.set(HIGHLIGHTS.resolved, api.make(...resolved));
  if (active.length > 0) api.registry.set(HIGHLIGHTS.active, api.make(...active));
  return { ranges, clear };
}

/** The thread whose mark holds this place in the text, the innermost if marks overlap; `undefined` if none does. */
export function threadAt(ranges: ReadonlyMap<string, Range>, node: Node, offset: number): string | undefined {
  let found: { id: string; size: number } | undefined;
  for (const [id, range] of ranges) {
    let inside = false;
    try {
      inside = range.isPointInRange(node, offset);
    } catch {
      inside = false;
    }
    if (!inside) continue;
    const size = range.toString().length;
    if (!found || size < found.size) found = { id, size };
  }
  return found?.id;
}

/** The place in the text under a point on the screen, by whichever of the browser's two ways it has. */
export function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | undefined {
  const withPosition = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const position = withPosition.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = withPosition.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
}
