// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type Fate, anchorAt, findAnchor, locate } from "./reanchor.js";
import type { TextQuoteAnchor } from "./types.js";

export { locate };

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

/** A thread whose text changed and was found again: its anchor as the app has it, and as it should be now. */
export interface Reanchor {
  id: string;
  from: TextQuoteAnchor;
  to: TextQuoteAnchor;
}

/** What was found of each thread in a page. `fates` has no entry for a thread that was not looked for (the search was too large to spend more on). */
export interface Marking {
  ranges: Map<string, Range>;
  fates: Map<string, Fate>;
  reanchored: Reanchor[];
}

/**
 * The range of text each thread marks in `root`, what became of each (ROADMAP 1d.2: `intact` if its quote is still there word for word,
 * `edited` if the text it was about was changed and has been found again, `outdated` if it is gone), and for the edited ones the anchor
 * that is true now, for the app to keep.
 */
export function analyse(root: Node, threads: readonly MarkedThread[]): Marking {
  const { text, segments } = flatten(root);
  const marking: Marking = { ranges: new Map(), fates: new Map(), reanchored: [] };
  if (segments.length === 0) return marking;
  const position = (offset: number, preferEnd: boolean): [Text, number] => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i]!;
      const end = segment.start + segment.node.data.length;
      if (offset >= segment.start && (offset < end || (preferEnd && offset === end))) return [segment.node, offset - segment.start];
    }
    const last = segments[segments.length - 1]!;
    return [last.node, last.node.data.length];
  };
  const spent: { cells: number; skipped?: boolean } = { cells: 0 };
  for (const thread of threads) {
    spent.skipped = false;
    const found = findAnchor(text, thread.anchor, spent);
    if (!found) {
      // Gone, unless it was not looked for (the pass had spent what it may): then nothing is said of it.
      if (!spent.skipped && thread.anchor.quote !== "") marking.fates.set(thread.id, "outdated");
      continue;
    }
    const range = root.ownerDocument!.createRange();
    const [startNode, startOffset] = position(found.start, false);
    const [endNode, endOffset] = position(found.end, true);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    marking.ranges.set(thread.id, range);
    marking.fates.set(thread.id, found.fate);
    if (found.fate === "edited") marking.reanchored.push({ id: thread.id, from: thread.anchor, to: anchorAt(text, found.start, found.end) });
  }
  return marking;
}

/** The range of text a thread marks in `root`, for each thread whose text is found. */
export const rangesFor = (root: Node, threads: readonly MarkedThread[]): Map<string, Range> => analyse(root, threads).ranges;

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
 * off, the ranges that were found (by thread), for finding which one a click was on, and what became of each thread (`analyse`).
 */
export function paintMarks(root: Node, threads: readonly MarkedThread[], activeId: string | null, api: HighlightApi | undefined = browserHighlights()): Marking & { clear: () => void } {
  const marking = analyse(root, threads);
  const { ranges } = marking;
  const clear = () => {
    for (const name of Object.values(HIGHLIGHTS)) api?.registry.delete(name);
  };
  if (!api) return { ...marking, clear };
  clear();
  const open = threads.filter((thread) => !thread.resolved && ranges.has(thread.id)).map((thread) => ranges.get(thread.id)!);
  const resolved = threads.filter((thread) => thread.resolved && ranges.has(thread.id)).map((thread) => ranges.get(thread.id)!);
  const active = activeId !== null && ranges.has(activeId) ? [ranges.get(activeId)!] : [];
  if (open.length > 0) api.registry.set(HIGHLIGHTS.open, api.make(...open));
  if (resolved.length > 0) api.registry.set(HIGHLIGHTS.resolved, api.make(...resolved));
  if (active.length > 0) api.registry.set(HIGHLIGHTS.active, api.make(...active));
  return { ...marking, clear };
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
