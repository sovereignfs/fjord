// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { $getRoot } from "lexical";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor.js";
import { sameMeaning } from "./rich/meaning.js";
import { LABEL, viewOf } from "./testing/surfaces.js";

/**
 * The round-trip corpus for documents (ROADMAP 1b.3): "every file opens and saves; unknown syntax survives untouched".
 *
 * Each file is opened in the document editor, which decides whether the visual editor can hold it without changing what it
 * means (`rich/meaning.ts`). The table below says which it should be for each file, so that a change in the editor's
 * behaviour, which is a library's, is seen. What holds for every file:
 *
 *  - opening it tells the app nothing: no edit, no draft;
 *  - in the visual editor, editing one word gives a text that means the original with that word changed, and nothing else;
 *  - as Markdown, editing one word gives the original with that word changed, byte for byte.
 *
 * `corpus/` holds notes (the note editor's corpus, too) and `corpus/documents/` what is particular to documents.
 */
afterEach(cleanup);

const root = join(import.meta.dirname, "..", "corpus");
type Mode = "visual" | "markdown";
const files = [
  ...readdirSync(root).filter((name) => name.endsWith(".md")).map((name) => ({ name, path: join(root, name) })),
  ...readdirSync(join(root, "documents")).map((name) => ({ name: `documents/${name}`, path: join(root, "documents", name) })),
].sort((a, b) => a.name.localeCompare(b.name));

/** Which editor each file opens in, and why when it is the Markdown. */
const EXPECTED: Record<string, Mode> = {
  "empty.md": "visual",
  "footnotes-and-html.md": "markdown", // raw HTML, and footnotes
  "front-matter-like.md": "visual",
  "journal-unicode.md": "visual",
  "long-lines.md": "visual",
  "math-and-tables.md": "markdown", // a ragged table row would be padded, and maths is written with dollars
  "meeting-notes.md": "visual",
  "one-line-no-newline.md": "visual",
  "readme-like.md": "markdown", // raw HTML (<details>)
  "recipe.md": "visual",
  "trailing-whitespace.md": "visual",
  "documents/adjacent-lists.md": "markdown", // two lists with different bullets would become one
  "documents/blockquotes.md": "visual",
  "documents/code-fences.md": "visual",
  "documents/footnotes.md": "markdown", // [^1] would be escaped, which a renderer with footnotes reads differently
  "documents/hard-break-trailing-spaces.md": "markdown", // a hard break written with spaces would become a soft one
  "documents/hard-breaks-and-escapes.md": "markdown", // raw `<3` and HTML entities
  "documents/headings-and-emphasis.md": "visual",
  "documents/links-and-images.md": "visual",
  "documents/lists-nested-and-tasks.md": "visual",
  "documents/loose-list.md": "markdown", // a loose list would become a tight one
  "documents/math.md": "markdown", // $…$ would be escaped
  "documents/odd-whitespace.md": "visual",
  "documents/raw-html.md": "markdown",
  "documents/reference-links.md": "markdown", // [text][ref] definitions
  "documents/restyled-but-same.md": "visual", // setext headings, star bullets, underscores: restyled, same meaning
  "documents/tab-indented-code.md": "visual", // an indented code block, which becomes a fenced one
  "documents/tables-aligned.md": "visual",
};

/** The first word of five letters or more that is in the document once only, and in its prose: not in code, a table, or a link's address and title. */
function aWord(text: string): string | undefined {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|^\|.*$|^( {4}|\t).*$|\]\([^)]*\)|<[^>\s]+>/gm, " ");
  for (const [word] of prose.matchAll(/[A-Za-z]{5,}/g)) if (text.split(word).length === 2) return word;
  return undefined;
}

/** The app: it keeps the text, as the page does, and remembers every text it was told. */
function App({ initial, told }: { initial: string; told: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  return <DocumentEditor aria-label={LABEL} role="edit" value={value} onChange={(text) => (told(text), setValue(text))} />;
}

const modeNow = () => document.querySelector("[data-mode]")?.getAttribute("data-mode");

async function open(text: string) {
  const told = vi.fn();
  render(<App initial={text} told={told} />);
  await screen.findAllByRole("textbox");
  return told;
}

/** Wait until the document editor has decided, and has settled on it. */
async function settled(expected: Mode) {
  // A slow machine takes longer to read the text than a fast one; waiting for the answer is not waiting for a time.
  if (expected === "markdown") await waitFor(() => expect(modeNow()).toBe("markdown"), { timeout: 8000 });
  else await new Promise((resolve) => setTimeout(resolve, 400));
  expect(modeNow()).toBe(expected);
}

describe("every file is in the table, and the table has no file that is not there", () => {
  it("lists the corpus", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(files.map((file) => file.name).sort());
    expect(Object.values(EXPECTED)).toContain("visual");
    expect(Object.values(EXPECTED)).toContain("markdown");
  });
});

describe("line endings", () => {
  it("a document with CRLF line endings is shown as Markdown, since the visual editor would write them all as LF", async () => {
    const text = readFileSync(join(root, "meeting-notes.md"), "utf8").replace(/\n/g, "\r\n");
    const told = await open(text);
    await settled("markdown");
    expect(told).not.toHaveBeenCalled();
    expect(viewOf(screen.getByRole("textbox", { name: LABEL })).state.sliceDoc()).toBe(text);
  });

  it("a document with a byte order mark is held as it is, whichever editor shows it", async () => {
    const text = `\ufeff${readFileSync(join(root, "meeting-notes.md"), "utf8")}`;
    const told = await open(text);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(told).not.toHaveBeenCalled();
    expect(["visual", "markdown"]).toContain(modeNow());
  });
});

describe.each(files)("$name", ({ name, path }) => {
  const text = readFileSync(path, "utf8");
  const mode = EXPECTED[name] as Mode;

  it(`opens in the ${mode === "visual" ? "visual editor" : "Markdown editor"}, and tells the app nothing`, async () => {
    const told = await open(text);
    await settled(mode);
    expect(told).not.toHaveBeenCalled();
    if (mode === "markdown") expect(screen.getByRole("note").textContent).toMatch(/shown as Markdown/);
    else expect(screen.queryByRole("note")).toBeNull();
  });

  const word = aWord(text);
  if (word === undefined) return;

  if (mode === "markdown") {
    it("is changed by an edit of one word in that word only, byte for byte", async () => {
      const told = await open(text);
      await settled("markdown");
      const view = viewOf(screen.getByRole("textbox", { name: LABEL }));
      const sliced = view.state.sliceDoc();
      const from = sliced.indexOf(word);
      view.dispatch({ changes: { from, to: from + word.length, insert: `${word}X` }, userEvent: "input.type" });
      await waitFor(() => expect(told).toHaveBeenCalledTimes(1));
      expect(told).toHaveBeenCalledWith(text.replace(word, `${word}X`));
    });
  } else {
    it("is changed by an edit of one word to a text that means the original with that word changed, and ends as it did", async () => {
      const told = await open(text);
      await settled("visual");
      const editor = (screen.getAllByRole("textbox", { name: LABEL })[0] as unknown as { __lexicalEditor: { update: (fn: () => void) => void } }).__lexicalEditor;
      let edited = false;
      editor.update(() => {
        for (const node of $getRoot().getAllTextNodes()) {
          const own = node.getTextContent();
          if (!edited && own.includes(word)) {
            node.setTextContent(own.replace(word, `${word}X`));
            edited = true;
          }
        }
      });
      expect(edited, `no text node holds "${word}"`).toBe(true);
      await waitFor(() => expect(told).toHaveBeenCalledTimes(1));
      const [result] = told.mock.calls[0] as [string];
      expect(sameMeaning(result, text.replace(word, `${word}X`)), `${JSON.stringify(result)}\nis not the original with ${word} changed`).toBe(true);
      expect(result.endsWith("\n")).toBe(text.endsWith("\n"));
      // And begins as it did: the blank lines a body has after its header are not the editor's to remove.
      expect(/^\n*/.exec(result)?.[0]).toBe(/^\n*/.exec(text)?.[0]);
    });
  }
});
