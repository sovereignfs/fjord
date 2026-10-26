// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./NoteEditor.js";
import { LABEL, positionOf, viewOf } from "./testing/surfaces.js";

/**
 * The note editor is byte-faithful (clients/web/DESIGN.md §10; ROADMAP 1b.2): a note is often edited by hand or in
 * Obsidian too, so opening one changes nothing and an edit changes only what the person changed. The corpus is real
 * Markdown; each file is also tried with other line endings, a byte order mark, no final newline and odd characters,
 * because those are what a general editor rewrites without being asked.
 */
afterEach(cleanup);

const corpusDir = join(import.meta.dirname, "..", "corpus");
const corpus = readdirSync(corpusDir)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(corpusDir, name), "utf8") }));

/** The same note as it would come from other tools. */
const variants: { name: string; of: (text: string) => string }[] = [
  { name: "as written", of: (text) => text },
  { name: "with CRLF line endings", of: (text) => text.replace(/\n/g, "\r\n") },
  { name: "with mixed line endings", of: (text) => text.split("\n").map((line, i) => line + (i % 2 ? "\r\n" : "\n")).join("").slice(0, -1) },
  { name: "with old-Mac CR line endings", of: (text) => text.replace(/\n/g, "\r") },
  { name: "with a byte order mark", of: (text) => "﻿" + text },
  { name: "with no final newline", of: (text) => text.replace(/\n+$/, "") },
  { name: "with blank lines first and last", of: (text) => "\n\n" + text + "\n\n" },
  { name: "with a NUL, a line separator and a paragraph separator in it", of: (text) => text.slice(0, 10) + "\u0000  " + text.slice(10) },
];

const mount = (value: string, props: { onChange?: (text: string) => void; readOnly?: boolean } = {}) =>
  render(<NoteEditor aria-label={LABEL} value={value} {...props} />);
const view = () => viewOf(screen.getByRole("textbox", { name: LABEL }));

/** Where the first word of at least five letters begins after a third of the text, if there is one. */
function aWord(text: string): { start: number; end: number } | undefined {
  const pattern = /[A-Za-z]{5,}/g;
  pattern.lastIndex = Math.floor(text.length / 3);
  const found = pattern.exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : undefined;
}

describe("a note from the corpus", () => {
  for (const { name, text } of corpus) {
    describe(name, () => {
      for (const variant of variants) {
        const original = variant.of(text);

        it(`opens exactly as it is, ${variant.name}, and says nothing`, () => {
          const onChange = vi.fn();
          mount(original, { onChange });
          expect(view().state.sliceDoc()).toBe(original);
          expect(onChange).not.toHaveBeenCalled();
        });

        const word = aWord(original);
        if (!word) continue;
        it(`changes only the word that was edited, ${variant.name}`, () => {
          const onChange = vi.fn();
          mount(original, { onChange });
          const editor = view();
          editor.dispatch({ changes: { from: positionOf(original, word.start), to: positionOf(original, word.end), insert: "REPLACED" }, userEvent: "input.type" });

          expect(onChange).toHaveBeenCalledTimes(1);
          // Everything before and after the word is the same bytes, and the word is the only thing that is not.
          expect(onChange).toHaveBeenCalledWith(original.slice(0, word.start) + "REPLACED" + original.slice(word.end));
        });
      }
    });
  }

  it("has real notes in it", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(10);
    expect(corpus.some(({ text }) => text.length === 0)).toBe(true);
    expect(corpus.some(({ text }) => text.includes("́"))).toBe(true);
  });
});

describe("line endings", () => {
  const enter = () => fireEvent.keyDown(screen.getByRole("textbox", { name: LABEL }), { key: "Enter", code: "Enter", keyCode: 13 });

  it("starts a new line the way the note's lines end, and keeps the indentation", () => {
    for (const [eol, original] of [["\r\n", "- one\r\n  indented"], ["\n", "- one\n  indented"]] as const) {
      const onChange = vi.fn();
      mount(original, { onChange });
      view().dispatch({ selection: { anchor: positionOf(original, original.length) } });
      enter();
      expect(onChange, JSON.stringify(eol)).toHaveBeenLastCalledWith(`${original}${eol}  `);
      cleanup();
    }
  });

  it("shows the carriage return of a note that mixes line endings as the control character it is, and not otherwise", () => {
    mount("a\r\nb\nc");
    expect(document.querySelectorAll(".cm-specialChar").length).toBeGreaterThan(0);
    cleanup();
    mount("a\r\nb\r\nc");
    expect(document.querySelectorAll(".cm-specialChar").length).toBe(0);
  });
});

describe("a text the app sets", () => {
  it("is shown without telling the app, and keeps the cursor where the person had it", () => {
    const onChange = vi.fn();
    const { rerender } = mount("hello world", { onChange });
    view().dispatch({ selection: { anchor: 2 } });

    rerender(<NoteEditor aria-label={LABEL} value="hello brave world" onChange={onChange} />);
    expect(view().state.sliceDoc()).toBe("hello brave world");
    expect(view().state.selection.main.head).toBe(2);

    view().dispatch({ selection: { anchor: 9 } });
    rerender(<NoteEditor aria-label={LABEL} value="oh hello brave world" onChange={onChange} />);
    expect(view().state.selection.main.head).toBe(12);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("can change the kind of line ending, which makes the note a different document", () => {
    const onChange = vi.fn();
    const { rerender } = mount("one\ntwo\n", { onChange });
    rerender(<NoteEditor aria-label={LABEL} value={"one\r\ntwo\r\n"} onChange={onChange} />);
    expect(view().state.sliceDoc()).toBe("one\r\ntwo\r\n");
    expect(view().state.lineBreak).toBe("\r\n");
    expect(onChange).not.toHaveBeenCalled();
    // And an edit afterwards is reported in that kind.
    view().dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledWith("Xone\r\ntwo\r\n");
  });

  it("is what the person is told next, when they keep editing", () => {
    const onChange = vi.fn();
    const { rerender } = mount("abc", { onChange });
    view().dispatch({ changes: { from: 3, insert: "d" }, userEvent: "input.type" });
    expect(onChange).toHaveBeenLastCalledWith("abcd");
    rerender(<NoteEditor aria-label={LABEL} value="abcd" onChange={onChange} />);
    view().dispatch({ changes: { from: 4, insert: "e" }, userEvent: "input.type" });
    expect(onChange).toHaveBeenLastCalledWith("abcde");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("reading and writing", () => {
  it("can be switched between, and refuses edits while it can only be read", () => {
    const onChange = vi.fn();
    const { rerender } = mount("text", { onChange, readOnly: true });
    expect(screen.getByRole("textbox", { name: LABEL }).getAttribute("aria-readonly")).toBe("true");
    // Not only refused when asked: the browser is told it cannot be typed in.
    expect(screen.getByRole("textbox", { name: LABEL }).getAttribute("contenteditable")).toBe("false");
    view().dispatch({ changes: { from: 0, insert: "no" }, userEvent: "input.type" });
    expect(view().state.sliceDoc()).toBe("text");

    rerender(<NoteEditor aria-label={LABEL} value="text" onChange={onChange} readOnly={false} />);
    expect(screen.getByRole("textbox", { name: LABEL }).getAttribute("aria-readonly")).toBe("false");
    expect(screen.getByRole("textbox", { name: LABEL }).getAttribute("contenteditable")).toBe("true");
    view().dispatch({ changes: { from: 0, insert: "yes " }, userEvent: "input.type" });
    expect(onChange).toHaveBeenCalledWith("yes text");

    rerender(<NoteEditor aria-label={LABEL} value="yes text" onChange={onChange} readOnly />);
    view().dispatch({ changes: { from: 0, insert: "no" }, userEvent: "input.type" });
    expect(view().state.sliceDoc()).toBe("yes text");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("still takes a text from the app while it can only be read", () => {
    const { rerender } = mount("one", { readOnly: true });
    rerender(<NoteEditor aria-label={LABEL} value="two" readOnly />);
    expect(view().state.sliceDoc()).toBe("two");
  });

  it("follows a change of its name", () => {
    const { rerender } = render(<NoteEditor aria-label="First" value="x" />);
    expect(screen.getByRole("textbox", { name: "First" })).toBeTruthy();
    rerender(<NoteEditor aria-label="Second" value="x" />);
    expect(screen.getByRole("textbox", { name: "Second" })).toBeTruthy();
  });

  it("goes away cleanly", () => {
    const { unmount, container } = mount("x");
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    unmount();
    expect(document.querySelector(".cm-editor")).toBeNull();
  });
});

describe("what it looks like", () => {
  it("marks up the Markdown with classes, and no colours of its own", () => {
    mount("# Heading\n\nsome *emphasis* and **strong** text and [a link](https://example.com)\n");
    const content = screen.getByRole("textbox", { name: LABEL });
    expect(content.querySelector(".tok-heading")).not.toBeNull();
    expect(content.querySelector(".tok-emphasis")).not.toBeNull();
    expect(content.querySelector(".tok-strong")).not.toBeNull();
    // Nothing is styled inline: the stylesheet, and through it the client's theme, decides.
    expect(content.querySelectorAll("[style*='color']").length).toBe(0);
  });
});
