// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { ANCHOR_CONTEXT, textQuoteAnchor } from "./anchor.js";

describe("textQuoteAnchor", () => {
  const body = "# Plan\n\nThe quick brown fox jumps over the lazy dog.\n";

  it("quotes the selection and keeps the text around it", () => {
    const start = body.indexOf("brown");
    expect(textQuoteAnchor(body, start, start + "brown fox".length)).toEqual({
      type: "text-quote",
      quote: "brown fox",
      prefix: "# Plan\n\nThe quick ",
      suffix: " jumps over the lazy dog.\n",
      position: start,
    });
  });

  it("keeps at most ANCHOR_CONTEXT characters either side", () => {
    const long = `${"a".repeat(100)}QUOTE${"b".repeat(100)}`;
    const anchor = textQuoteAnchor(long, 100, 105);
    expect(anchor.prefix).toBe("a".repeat(ANCHOR_CONTEXT));
    expect(anchor.suffix).toBe("b".repeat(ANCHOR_CONTEXT));
  });

  it("works at the very start and the very end of the body", () => {
    expect(textQuoteAnchor("abc", 0, 3)).toEqual({ type: "text-quote", quote: "abc", prefix: "", suffix: "", position: 0 });
    expect(textQuoteAnchor("abc", 2, 3)).toMatchObject({ quote: "c", prefix: "ab", suffix: "" });
  });

  it("counts UTF-16 code units, as the body is a JavaScript string", () => {
    const text = "😀 hello";
    expect(textQuoteAnchor(text, 3, 8)).toMatchObject({ quote: "hello", prefix: "😀 ", position: 3 });
  });

  it("refuses a selection that is empty or is not inside the body", () => {
    for (const [start, end] of [[2, 2], [3, 2], [-1, 2], [0, 4], [0.5, 2], [0, Number.NaN]] as const) {
      expect(() => textQuoteAnchor("abc", start, end), `${start}..${end}`).toThrow(RangeError);
    }
  });
});
