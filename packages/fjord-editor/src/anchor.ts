// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { TextQuoteAnchor } from "./types.js";

/** How much text either side of a quote is kept in its anchor (DESIGN.md §13). */
export const ANCHOR_CONTEXT = 32;

/**
 * The anchor for the part of `body` from `start` to `end` (UTF-16 offsets, `end` not included). Throws a
 * `RangeError` for a selection that is empty or is not inside the body: there is nothing to comment on.
 */
export function textQuoteAnchor(body: string, start: number, end: number): TextQuoteAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > body.length || start >= end) {
    throw new RangeError(`there is no selection from ${start} to ${end} in a body of ${body.length} characters`);
  }
  return {
    type: "text-quote",
    quote: body.slice(start, end),
    prefix: body.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: body.slice(end, end + ANCHOR_CONTEXT),
    position: start,
  };
}
