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
    ["a numbered heading's number, escaped or not (a heading is never a list)", "## 1\\. Introduction\n", "## 1. Introduction\n"],
    ["a bracket as a character reference and as an escape, and a closing bracket escaped or not", "&#91;embedded content: a\\]\n", "\\[embedded content: a]\n"],
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
    ["a numbered line that is not a list, and one that is", "1\\. Introduction\n", "1. Introduction\n"],
    ["a numbered heading's number in a paragraph", "text 1\\. not\n", "text 1. not\n"],
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

describe("where two texts differ", () => {
  it("says the line, what is written, and what would be written, for the spot and not the whole paragraph", async () => {
    const { differences } = await import("./meaning.js");
    const original = "# Title\n\nA first paragraph that is fine.\n\nSee [[Roadmap]] soon.\n\nEnd.\n";
    const written = "# Title\n\nA first paragraph that is fine.\n\nSee \\[\\[Roadmap]] soon.\n\nEnd.\n";
    expect(sameMeaning(original, written)).toBe(false);
    expect(differences(original, written)).toEqual([{ line: 5, written: "See [[Roadmap]] soon.", becomes: "See \\[\\[Roadmap]] soon." }]);
  });

  it("finds the word in a long line, and every spot when there are several", async () => {
    const { differences } = await import("./meaning.js");
    const filler = "word ".repeat(40);
    const found = differences(`${filler}[[Other note]] and more.\n\n- one\n- two\n\nTail [[Again]].\n`, `${filler}\\[\\[Other note]] and more.\n\n- one\n- two\n\nTail \\[\\[Again]].\n`);
    expect(found).toHaveLength(2);
    expect(found[0]!.line).toBe(1);
    expect(found[0]!.written).toContain("[[Other note]]");
    expect(found[0]!.written.length).toBeLessThan(120);
    expect(found[1]).toMatchObject({ line: 6, written: expect.stringContaining("[[Again]]") });
  });

  it("says a block that would be dropped is dropped, and says nothing for texts that mean the same", async () => {
    const { differences } = await import("./meaning.js");
    expect(differences("text\n\n[ref]: http://x.example\n", "text\n")).toEqual([{ line: 3, written: "[ref]: http://x.example", becomes: null }]);
    expect(differences("- a\n- b\n", "* a\n* b\n")).toEqual([]);
  });

  it("is limited, since a person fixes them one at a time", async () => {
    const { differences } = await import("./meaning.js");
    const many = Array.from({ length: 30 }, (_, i) => `See [[Note ${i}]].`).join("\n\n");
    const escaped = Array.from({ length: 30 }, (_, i) => `See \\[\\[Note ${i}]].`).join("\n\n");
    expect(differences(many, escaped, 5)).toHaveLength(5);
  });
});

describe("what the visual editor cannot read", () => {
  it("is raw HTML, found by line, when that is what the editor named", async () => {
    const { unreadable } = await import("./meaning.js");
    const text = "Intro.\n\n<details>\n<summary>More</summary>\n\nInside.\n\n</details>\n\nA <b>bold</b> word.\n";
    const why = unreadable(text, 'Parsing of the following markdown structure failed: {"type":"html","name":"N/A"}');
    expect(why.reason).toBe("html");
    expect((why as { spots: { line: number; written: string }[] }).spots.map((spot) => [spot.line, spot.written])).toEqual([
      [3, "<details> <summary>More</summary>"],
      [8, "</details>"],
      [10, "<b>"],
      [10, "</b>"],
    ]);
  });

  it("is the structure it named, otherwise, and a plain sentence when it named nothing", async () => {
    const { unreadable } = await import("./meaning.js");
    expect(unreadable("x", 'failed: {"type":"mdxJsxFlowElement"}')).toEqual({ reason: "unreadable", detail: "it contains a mdxJsxFlowElement that it cannot hold" });
    expect(unreadable("x", "")).toEqual({ reason: "unreadable", detail: "the visual editor could not read it" });
  });
});
