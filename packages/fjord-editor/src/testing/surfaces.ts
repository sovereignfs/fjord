// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { lineSeparatorOf } from "../note-state.js";

/**
 * The editing surface of an editor, as a test touches it. The contract is written against this, so the same tests hold
 * whatever is behind the interface: MDXEditor in the document editor, CodeMirror in the note editor and in a document
 * the visual editor cannot hold. A new core is a new `Surface`, and nothing else in the tests.
 */
export interface Surface {
  /** The editing surface itself: what a person with a screen reader is told is a text box. */
  element(): HTMLElement;
  /** The text as the editor holds it. */
  text(): string;
  /** The person changes the text to this. */
  edit(text: string): void;
  /** The person selects from `start` to `end` (offsets in the text). */
  select(start: number, end: number): void;
  /** Whether it says it can only be read. */
  readOnly(): boolean;
}

export const LABEL = "Editor";
const byLabel = () => screen.getByRole("textbox", { name: LABEL });

/** The Lexical editor behind a visual surface: Lexical keeps it on the element it edits. */
function lexicalOf(element: HTMLElement): LexicalEditor {
  const editor = (element as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error("this is not a visual editor");
  return editor;
}

/**
 * The visual editor (MDXEditor, on Lexical). Its text is what a person reads, so `text()` is the plain text of a document of
 * paragraphs, which is what the contract's texts are; `edit` is the person's edit made as Lexical makes one (an update of the
 * editor's state), which the component sees as it sees a keystroke.
 */
export const visual: Surface = {
  element: byLabel,
  text: () => byLabel().textContent ?? "",
  edit(text) {
    const editor = lexicalOf(byLabel());
    // A person cannot type into what is read-only; an update made in code could, so the surface does not make one.
    if (!editor.isEditable()) return;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(text));
      root.append(paragraph);
    });
  },
  select(start, end) {
    // Offsets in the text a person reads, which runs across the text nodes of formatting.
    const at = (offset: number): [Node, number] => {
      const walker = document.createTreeWalker(byLabel(), NodeFilter.SHOW_TEXT);
      let left = offset;
      let last: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        last = node;
        const length = node.textContent?.length ?? 0;
        if (left <= length) return [node, left];
        left -= length;
      }
      if (!last) throw new Error("there is no text to select in");
      return [last, last.textContent?.length ?? 0];
    };
    const range = document.createRange();
    range.setStart(...at(start));
    range.setEnd(...at(end));
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  },
  readOnly: () => byLabel().getAttribute("aria-readonly") === "true" || byLabel().getAttribute("contenteditable") === "false",
};

/** The editor view behind a CodeMirror surface. */
export function viewOf(element: HTMLElement): EditorView {
  const editor = element.closest(".cm-editor");
  const view = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
  if (!view) throw new Error("this is not a CodeMirror editor");
  return view;
}

/** A position in the document for an offset in the text: where every line break is two characters, each is one position. */
export function positionOf(text: string, offset: number): number {
  if (lineSeparatorOf(text) !== "\r\n") return offset;
  return offset - (text.slice(0, offset).match(/\r\n/g)?.length ?? 0);
}

export const codeMirror: Surface = {
  element: byLabel,
  text: () => viewOf(byLabel()).state.sliceDoc(),
  edit(text) {
    const view = viewOf(byLabel());
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" });
  },
  select(start, end) {
    const view = viewOf(byLabel());
    const text = view.state.sliceDoc();
    view.dispatch({ selection: { anchor: positionOf(text, start), head: positionOf(text, end) } });
  },
  readOnly: () => byLabel().getAttribute("aria-readonly") === "true",
};
