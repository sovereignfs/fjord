// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { keepsLineEndings, meaningOf, sameMeaning, withEdgesLike } from "./meaning.js";

/** What counts as the same document, and what does not: the visual editor may restyle a document, never change it. */
describe("two texts that mean the same", () => {
  it.each([
    ["bullets", "- a\n- b\n", "* a\n* b\n"],
    ["emphasis and strong", "_a_ and __b__", "*a* and **b**"],
    ["rules", "a\n\n---\n\nb", "a\n\n***\n\nb"],
    ["heading styles", "Title\n=====\n", "# Title\n"],
    ["code fences", "```\ncode\n```", "~~~\ncode\n~~~"],
    ["blank lines between blocks", "# T\ntext\n", "# T\n\ntext\n"],
    ["a final line break", "a", "a\n"],
    ["a table's padding", "| a | b |\n|---|---|\n| 1 | 2 |", "| a   | b   |\n| --- | --- |\n| 1   | 2   |"],
    ["a hard break's two spellings", "a  \nb", "a\\\nb"],
    ["a quote's lazy line and the same line quoted", "> a\nb\n", "> a\n> b\n"],
    ["a list item's continuation, indented differently", "- a\n    b\n", "- a\n  b\n"],
  ])("are the same in %s", (_name, a, b) => {
    expect(sameMeaning(a, b)).toBe(true);
  });
});

describe("two texts that do not", () => {
  it.each([
    ["a tab-indented code block and a list", "text\n\n\t- item\n\t- other\n", "text\n\n- item\n- other\n"],
    ["a table padded with a cell it did not have", "| a | b |\n|---|:-:|\n| 1 | 2 | 3 |\n", "| a | b |  |\n|---|:-:|---|\n| 1 | 2 | 3 |\n"],
    ["a footnote and its absence", "a[^1]\n\n[^1]: note\n", "a[^1]\n"],
    ["emphasis and none", "*a*", "a"],
    ["a loose list and a tight one", "- a\n\n- b\n", "- a\n- b\n"],
    ["a link and its text", "[a](http://x.example)", "a"],
    ["a different link", "[a](http://x.example)", "[a](http://y.example)"],
    ["different words", "one two", "one three"],
    ["a task and a bullet", "- [ ] a\n", "- a\n"],
    ["strikethrough and none", "~~a~~", "a"],
    ["a wiki link and an escaped one", "See [[Other note]] here.", "See \\[\\[Other note]] here."],
    ["a footnote reference and an escaped one", "Text[^1]\n\n[^1]: Note.\n", "Text\\[^1]\n\n\\[^1]: Note.\n"],
    ["a highlight and an escaped one", "a ==marked== b", "a \\=\\=marked\\=\\= b"],
    ["a tag and an escaped one", "a #tag b", "a \\#tag b"],
  ])("differ in %s", (_name, a, b) => {
    expect(sameMeaning(a, b)).toBe(false);
  });

  it("describes a text the same way each time, and differently for different ones", () => {
    expect(meaningOf("# a")).toBe(meaningOf("# a"));
    expect(meaningOf("# a")).not.toBe(meaningOf("## a"));
  });
});

describe("the edges of a document", () => {
  it.each([
    ["a document that ended with one", "a\n", "a", "a\n"],
    ["a document that ended with several", "a\n\n\n", "a", "a\n"],
    ["a document that ended with none", "a", "a", "a"],
    ["an editor that wrote one already", "a", "a\n", "a"],
    ["an empty document", "", "", ""],
    ["a document that was only a line break", "\n", "", "\n"],
    ["an empty original given text", "", "a", "a\n"],
    ["the blank line a body has after its header", "\n# Title\n", "# Title", "\n# Title\n"],
    ["several blank lines at the start", "\n\n\ntext\n", "text", "\n\n\ntext\n"],
    ["a blank line made of spaces", "  \ntext\n", "text", "  \ntext\n"],
    ["a CRLF blank line", "\r\ntext\r\n", "text", "\r\ntext\n"],
    ["no blank line at the start, none added", "text\n", "text", "text\n"],
    ["blank lines the editor wrote that the original did not have", "text\n", "\n\ntext", "text\n"],
    ["leading spaces that are text, not a blank line", "  indented\n", "indented", "indented\n"],
  ])("is kept as it was: %s", (_name, original, exported, expected) => {
    expect(withEdgesLike(original, exported)).toBe(expected);
  });
});

describe("line endings", () => {
  it("are kept by the visual editor only when there is none but a line feed", () => {
    expect(keepsLineEndings("a\nb\n")).toBe(true);
    expect(keepsLineEndings("")).toBe(true);
    expect(keepsLineEndings("a\r\nb\r\n")).toBe(false);
    expect(keepsLineEndings("a\rb")).toBe(false);
    expect(keepsLineEndings("mostly\nlf\r\n")).toBe(false);
  });
});
