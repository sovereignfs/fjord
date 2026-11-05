// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where in a Markdown body a selection is, for a selection made in the Markdown itself, or where no rendered text can say. The visual editor's own selection is what a person reads,
 * which is not the Markdown (a word in bold is `**word**` there), so it is anchored over the rendered text instead (`anchorOfRange` in `marks.ts`), which is where a thread's mark is found.
 *
 * Returns UTF-16 offsets into `body`, `end` not included, or null if the text is empty or is not in the body exactly once
 * in the way it was read. A text that is in the body more than once is anchored at its first place, with the context
 * `textQuoteAnchor` keeps either side of it.
 */
export function offsetsOfSelectedText(body: string, selected: string): [number, number] | null {
  const text = selected.trim();
  if (text === "") return null;
  const start = body.indexOf(text);
  return start < 0 ? null : [start, start + text.length];
}
