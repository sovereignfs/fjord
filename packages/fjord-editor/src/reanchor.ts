// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ANCHOR_CONTEXT } from "./anchor.js";
import type { TextQuoteAnchor } from "./types.js";

/**
 * Finding a thread's text again after the document changed from outside (ROADMAP 1d.2, clients/web/DESIGN.md §13). A thread's anchor is
 * the quote, a little text either side of it and where it was, over the plain text of the document. When the document changes:
 *
 *  1. If the quote is still there **word for word**, that is the place (several: the one whose surroundings are most like the anchor's,
 *     nearest the hint on a tie). Edits around it, before it or after it, do not touch the thread: its fate is `intact`.
 *  2. Otherwise the text it was about may have been **edited**: the place whose text is most like the quote, if it is like it enough (at
 *     most 30% of the quote's characters different, and the quote is long enough for that to mean something). The thread follows the
 *     edit, and its fate is `edited`: the app keeps the new quote, so that the next change is compared with what is there now.
 *  3. Otherwise the text is gone (deleted, or replaced by something else), and the thread is `outdated`: not marked, but kept in the
 *     panel with its comments, never dropped.
 *
 * Nothing here reads a document: it is given the text and the anchor.
 */
export type Fate = "intact" | "edited" | "outdated";

/** Where a quote was found: `start` to `end` (not included) in the text, UTF-16 offsets. */
export interface Found {
  start: number;
  end: number;
  fate: "intact" | "edited";
}

/** A quote shorter than this is found only word for word: a few characters are too alike too many places for "alike" to mean anything. */
export const MIN_FUZZY_QUOTE = 12;
/** How much of a quote may differ, as a fraction of its length, for a place to still be its text. */
export const MAX_DIFFERENCE = 0.3;
/** The most cells of work (quote length by text length) one search may spend, so that a very large document cannot stall the page. */
const MAX_CELLS = 20_000_000;

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
 * Where a thread's quote is in `text`, word for word: the place whose surroundings are most like the anchor's, nearest the hint on a tie,
 * or `undefined` if the quote is not there at all.
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

/**
 * The part of `text` most like `quote` by edit distance (an insertion, a deletion or a changed character counts one each), if it differs by
 * no more than `budget`: Sellers' approximate substring matching, which lets a match begin anywhere. Of equal matches, the one as long as the quote, then the nearest `hint`.
 */
function closest(text: string, quote: string, budget: number, hint: number): { start: number; end: number } | undefined {
  const m = quote.length;
  // A column of the table for one more character of the text: how far the first `i` characters of the quote are from the best ending here,
  // and where that match began.
  let previous = new Int32Array(m + 1);
  let previousStart = new Int32Array(m + 1);
  let current = new Int32Array(m + 1);
  let currentStart = new Int32Array(m + 1);
  for (let i = 0; i <= m; i++) previous[i] = i; // before any of the text: the quote against nothing
  let best: { start: number; end: number; distance: number; lengthOff: number; away: number } | undefined;
  for (let j = 1; j <= text.length; j++) {
    current[0] = 0;
    currentStart[0] = j; // nothing of the quote matched yet: a match could begin right here
    const character = text.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      let cost = previous[i - 1]! + (quote.charCodeAt(i - 1) === character ? 0 : 1);
      let start = previousStart[i - 1]!;
      const extraInText = previous[i]! + 1;
      if (extraInText < cost) {
        cost = extraInText;
        start = previousStart[i]!;
      }
      const missingFromText = current[i - 1]! + 1;
      if (missingFromText < cost) {
        cost = missingFromText;
        start = currentStart[i - 1]!;
      }
      current[i] = cost;
      currentStart[i] = start;
    }
    const distance = current[m]!;
    if (distance <= budget) {
      const start = currentStart[m]!;
      // Of matches as close, the one as long as the quote, then the nearest the hint: not one that stops short only because the rest differed.
      const lengthOff = Math.abs(j - start - m);
      const away = Math.abs(start - hint);
      const better = !best || distance < best.distance || (distance === best.distance && (lengthOff < best.lengthOff || (lengthOff === best.lengthOff && away < best.away)));
      if (better) best = { start, end: j, distance, lengthOff, away };
    }
    [previous, current] = [current, previous];
    [previousStart, currentStart] = [currentStart, previousStart];
  }
  return best ? { start: best.start, end: best.end } : undefined;
}

/**
 * Where a thread's text is now: word for word if it still is, else the nearest edited form of it, else `undefined` (outdated). `spent`, if
 * given, counts the cells of work already spent on this pass and is added to; once it passes the allowance no more fuzzy searches are made
 * (`spent.skipped` is then set: the thread was not looked for, which is not the same as not being there).
 */
export function findAnchor(text: string, anchor: TextQuoteAnchor, spent?: { cells: number; skipped?: boolean }): Found | undefined {
  const exact = locate(text, anchor);
  if (exact !== undefined) return { start: exact, end: exact + anchor.quote.length, fate: "intact" };
  const quote = anchor.quote;
  if ([...quote].length < MIN_FUZZY_QUOTE) return undefined;
  const budget = Math.floor(quote.length * MAX_DIFFERENCE);

  // A large text is searched only near where the quote was: as much of it as the allowance for one search pays for.
  let from = 0;
  let to = text.length;
  const room = Math.max(quote.length * 4, Math.floor(MAX_CELLS / quote.length));
  if (text.length > room) {
    from = Math.max(0, Math.min(anchor.position - Math.floor(room / 2), text.length - room));
    to = from + room;
  }
  const work = (to - from) * quote.length;
  if (spent) {
    spent.skipped = false;
    if (spent.cells + work > MAX_CELLS * 5) {
      spent.skipped = true;
      return undefined;
    }
    spent.cells += work;
  }
  const near = closest(text.slice(from, to), quote, budget, anchor.position - from);
  if (!near) return undefined;
  let start = from + near.start;
  let end = from + near.end;
  // A quote does not begin or end in a space, as a selection is trimmed.
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return start < end ? { start, end, fate: "edited" } : undefined;
}

/** The anchor for `start` to `end` of `text`, as a thread is made with. */
export function anchorAt(text: string, start: number, end: number): TextQuoteAnchor {
  return {
    type: "text-quote",
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
    position: start,
  };
}
