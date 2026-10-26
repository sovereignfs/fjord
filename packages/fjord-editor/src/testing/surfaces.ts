// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fireEvent, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { lineSeparatorOf } from "../note-state.js";

/**
 * The editing surface of an editor, as a test touches it. The contract is written against this, so the same tests hold
 * whatever is behind the interface: the text area that stands in for the document editor now, CodeMirror in the note
 * editor, and MDXEditor in the document editor later. A new core is a new `Surface`, and nothing else in the tests.
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

export const textArea: Surface = {
  element: byLabel,
  text: () => (byLabel() as HTMLTextAreaElement).value,
  edit: (text) => void fireEvent.change(byLabel(), { target: { value: text } }),
  select(start, end) {
    (byLabel() as HTMLTextAreaElement).setSelectionRange(start, end);
    fireEvent.select(byLabel());
  },
  readOnly: () => byLabel().getAttribute("aria-readonly") === "true",
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
