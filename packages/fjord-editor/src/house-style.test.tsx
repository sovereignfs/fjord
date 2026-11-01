// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $getRoot } from "lexical";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentEditor } from "./DocumentEditor.js";
import { HOUSE_STYLE } from "./rich/style.js";
import { LABEL, viewOf } from "./testing/surfaces.js";

/**
 * The house style (ROADMAP 1b.4, `src/rich/style.ts`, `clients/web/DESIGN.md` §10): what the visual document editor writes, held to the
 * decisions rather than to a library's defaults.
 *
 *  - a document already in the style comes back byte for byte: opening it asks nothing and an edit changes the lines the person edited;
 *  - a document in another style is restyled when it is edited, and the person is told exactly which lines before they edit, and chooses.
 */
afterEach(cleanup);

const corpus = readFileSync(join(import.meta.dirname, "..", "corpus", "house-style", "everything.md"), "utf8");

function App({ initial, told }: { initial: string; told: (text: string) => void }) {
  const [value, setValue] = useState(initial);
  return <DocumentEditor aria-label={LABEL} role="edit" value={value} onChange={(text) => (told(text), setValue(text))} />;
}

async function open(text: string) {
  const told = vi.fn();
  render(<App initial={text} told={told} />);
  await screen.findAllByRole("textbox");
  // The visual editor reads the text a moment after it is made, and says what it would restyle; a slow machine takes longer.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return told;
}

const asked = () => screen.queryByRole("region", { name: "Reformatting" });
const listed = () => Array.from(screen.getByLabelText("Lines that would change").querySelectorAll("span")).map((line) => line.textContent?.replace(/\n$/, ""));

function editWord(word: string) {
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
}

describe("the style, as decisions", () => {
  it("is what the design says: - bullets, * emphasis and strong, --- rules, 1. on every numbered item, compact tables, fences", () => {
    expect(HOUSE_STYLE.toMarkdown).toEqual({ bullet: "-", emphasis: "*", strong: "*", rule: "-", listItemIndent: "one", fences: true, incrementListMarker: false });
    expect(HOUSE_STYLE.table).toEqual({ tableCellPadding: true, tablePipeAlign: false });
  });
});

describe("a document already in the house style", () => {
  it("opens without asking, in the visual editor, and tells the app nothing", async () => {
    const told = await open(corpus);
    expect(document.querySelector("[data-mode]")?.getAttribute("data-mode")).toBe("visual");
    expect(asked()).toBeNull();
    expect(told).not.toHaveBeenCalled();
  });

  it.each(["emphasis", "second nested", "another bullet", "third step", "task done", "quotation", "Lists"])("is changed by an edit of %s in that word only, byte for byte", async (word) => {
    const told = await open(corpus);
    editWord(word);
    await waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(told).toHaveBeenCalledWith(corpus.replace(word, `${word}X`));
  });
});

describe("a document in another style", () => {
  const cases: [string, string, string[]][] = [
    ["a star bullet", "* one\n* two\n\ntext\n", ["- * one", "- * two", "+ - one", "+ - two"]],
    ["underscore emphasis and strong", "an _emphasis_ and a __strong__ word\n", ["- an _emphasis_ and a __strong__ word", "+ an *emphasis* and a **strong** word"]],
    ["a numbered list that counts", "1. a\n2. b\n3. c\n", ["- 2. b", "- 3. c", "+ 1. b", "+ 1. c"]],
    ["a setext heading", "Title\n=====\n\ntext\n", ["- Title", "- =====", "+ # Title"]],
    ["a star rule", "one\n\n***\n\ntwo\n", ["- ***", "+ ---"]],
    ["a table padded to line up", "| a   | b     |\n| --- | ----- |\n| 1   | 22222 |\n| 333 | 4     |\n", ["- | a   | b     |", "- | --- | ----- |", "- | 1   | 22222 |", "- | 333 | 4     |", "+ | a | b |", "+ | --- | --- |", "+ | 1 | 22222 |", "+ | 333 | 4 |"]],
    ["an indented code block", "text\n\n    code\n\nmore\n", ["-     code", "+ ```", "+ code"]],
  ];

  it.each(cases)("%s: the lines that would change are listed before anything is edited", async (_name, text, lines) => {
    const told = await open(text);
    expect(asked()).not.toBeNull();
    // Nothing is editable, and nothing was told, until the person chooses.
    expect(screen.getAllByRole("textbox", { name: LABEL })[0]?.getAttribute("contenteditable")).toBe("false");
    expect(told).not.toHaveBeenCalled();
    const shown = listed();
    for (const line of lines.filter((line) => line.trim().length > 2)) expect(shown).toContain(line);
  });
});

describe("the choice a document in another style asks for", () => {
  const original = "* one\n* two\n\nsome text here\n";

  it("to be reformatted: the editor becomes editable, and an edit is written in the house style, with the lines the person did not touch restyled too", async () => {
    const told = await open(original);
    fireEvent.click(screen.getByRole("button", { name: "Reformat and edit here" }));
    await waitFor(() => expect(asked()).toBeNull());
    expect(screen.getAllByRole("textbox", { name: LABEL })[0]?.getAttribute("contenteditable")).toBe("true");
    editWord("text");
    await waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(told).toHaveBeenCalledWith("- one\n- two\n\nsome textX here\n");
  });

  it("to be edited as Markdown instead: the document is shown exactly as written, and an edit changes only the word", async () => {
    const told = await open(original);
    fireEvent.click(screen.getByRole("button", { name: "Edit as Markdown, unchanged" }));
    await waitFor(() => expect(document.querySelector("[data-mode]")?.getAttribute("data-mode")).toBe("markdown"));
    expect(asked()).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/You chose to edit this document as Markdown/);
    const view = viewOf(screen.getByRole("textbox", { name: LABEL }));
    expect(view.state.sliceDoc()).toBe(original);
    const from = view.state.sliceDoc().indexOf("text");
    view.dispatch({ changes: { from, to: from + 4, insert: "textX" }, userEvent: "input.type" });
    await waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(told).toHaveBeenCalledWith("* one\n* two\n\nsome textX here\n");
  });

  it("is not asked of a person who cannot edit, since nothing will be written", async () => {
    render(<DocumentEditor aria-label={LABEL} role="view" value={original} />);
    await screen.findAllByRole("textbox");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(asked()).toBeNull();
  });

  it("is asked again of a text the app sets afterwards that is not in the style, and not of one that is", async () => {
    function Swap() {
      const [value, setValue] = useState(original);
      return (
        <>
          <button type="button" onClick={() => setValue("# Other\n\n* a\n")}>
            other
          </button>
          <button type="button" onClick={() => setValue("# Fine\n\n- a\n")}>
            fine
          </button>
          <DocumentEditor aria-label={LABEL} role="edit" value={value} />
        </>
      );
    }
    render(<Swap />);
    await screen.findAllByRole("textbox");
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.click(screen.getByRole("button", { name: "Reformat and edit here" }));
    await waitFor(() => expect(asked()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "other" }));
    await waitFor(() => expect(asked()).not.toBeNull(), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "fine" }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(asked()).toBeNull();
  });

  it("says how many lines would change, and how many would go and come when they differ", async () => {
    await open("* one\n* two\n");
    expect(asked()?.textContent).toMatch(/2 lines would change/);
    cleanup();
    await open("Title\n=====\n");
    expect(asked()?.textContent).toMatch(/2 lines would go and 1 line would come/);
  });
});
