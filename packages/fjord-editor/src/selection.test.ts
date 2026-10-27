// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { offsetsOfSelectedText } from "./selection.js";

describe("finding a selection in the Markdown", () => {
  const body = "# Plan\n\nThe quick brown fox jumps over the lazy dog. The quick end.\n";

  it("finds plain text, trimmed of the white space the selection came with", () => {
    expect(offsetsOfSelectedText(body, "lazy dog")).toEqual([body.indexOf("lazy dog"), body.indexOf("lazy dog") + 8]);
    expect(offsetsOfSelectedText(body, "  lazy dog \n")).toEqual([body.indexOf("lazy dog"), body.indexOf("lazy dog") + 8]);
  });

  it("anchors a text that is there more than once at its first place", () => {
    expect(offsetsOfSelectedText(body, "The quick")).toEqual([body.indexOf("The quick"), body.indexOf("The quick") + 9]);
  });

  it("finds nothing for what is not in the body as it was read: across formatting, or blocks", () => {
    expect(offsetsOfSelectedText("a **bold** word", "a bold word")).toBeNull();
    expect(offsetsOfSelectedText(body, "Plan The quick")).toBeNull();
  });

  it("finds nothing for an empty selection", () => {
    expect(offsetsOfSelectedText(body, "")).toBeNull();
    expect(offsetsOfSelectedText(body, "   \n ")).toBeNull();
  });

  it("counts a character outside the basic plane as the two it is", () => {
    const text = "x 💧 y";
    const [start, end] = offsetsOfSelectedText(text, "💧")!;
    expect(text.slice(start, end)).toBe("💧");
    expect(end - start).toBe(2);
  });
});
