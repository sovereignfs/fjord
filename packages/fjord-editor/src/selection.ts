// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where in a Markdown body a selection is. In the visual editor a person selects what they read, which is not the Markdown
 * (a word in bold is `**word**` there), so the selection's text is looked for in the body. That finds a selection of
 * plain text within a block, and finds nothing for one that crosses formatting or blocks: such a selection is not anchored
 * here. The marks that show a thread in the text are `marks.ts` (ROADMAP 1d.1); this is how a selection becomes the anchor a thread
 * is made with.
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
