// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { pageNonce } from "./csp.js";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

/**
 * What makes the note editor's text faithful. A note is often edited by hand or in Obsidian too, so an edit has to change
 * only what the person changed (clients/web/DESIGN.md §10): not the line endings, not a byte order mark, not a character
 * that is merely unusual. CodeMirror keeps all of that if it is told what a line break is.
 */

/** Marks a change that came from outside the editor (the app set `value`), so it is not reported as an edit. */
export const External = Annotation.define<boolean>();

/**
 * What separates the lines of `text`: CRLF if every line break in it is one, else LF. A text with both, or with a lone
 * carriage return, is read as LF-separated and its carriage returns are kept as characters (and shown as the marker for
 * a control character), because CodeMirror has one line separator for a document and a file that mixes them cannot be
 * both without changing something.
 */
export function lineSeparatorOf(text: string): "\r\n" | "\n" {
  if (!text.includes("\r\n")) return "\n";
  return /(?<!\r)\n|\r(?!\n)/.test(text) ? "\n" : "\r\n";
}

/** The smallest change that turns `from` into `to`: what lies between their common beginning and common end. */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let start = 0;
  const shortest = Math.min(from.length, to.length);
  while (start < shortest && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let endFrom = from.length;
  let endTo = to.length;
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--;
    endTo--;
  }
  // Not through the middle of a surrogate pair: a change starts and ends between characters.
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1)) && start < to.length) start--;
  else if (endFrom < from.length && isLowSurrogate(from.charCodeAt(endFrom)) && endFrom > start) {
    endFrom++;
    endTo++;
  }
  return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The parts of the editor that change while it lives: what it may do, and what it is called. */
export const settings = {
  readOnly: new Compartment(),
  label: new Compartment(),
};

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) })];
}

export function labelExtension(label: string | undefined): Extension {
  return EditorView.contentAttributes.of(label === undefined ? {} : { "aria-label": label });
}

/** A new state for `text`, with everything the editor needs. `isReadOnly` says whether the app may be told of edits at all. */
function nonceExtension() {
  const nonce = pageNonce();
  return nonce === undefined ? [] : [EditorView.cspNonce.of(nonce)];
}

export function createState(text: string, options: { readOnly: boolean; label: string | undefined; isReadOnly: () => boolean; onEdit: (text: string) => void }): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      EditorState.lineSeparator.of(lineSeparatorOf(text)),
      history(),
      // The Markdown language's own keymap ("continue the list") is left out: it decides what the person's next line says,
      // which a minimal editor does not. Enter starts a line the way the note's lines end, and keeps the indentation.
      keymap.of([...defaultKeymap, ...historyKeymap]),
      highlightSpecialChars(),
      markdown({ addKeymap: false }),
      // Classes and not colours, so that the stylesheet, and through it the client's theme, decides what they look like.
      syntaxHighlighting(classHighlighter),
      EditorView.lineWrapping,
      // CodeMirror's own stylesheet is an element made at run time: under a Content-Security-Policy it needs the page's nonce (`csp.ts`).
      ...nonceExtension(),
      // A text that may only be read does not change, whoever asks: a command, a paste, a script.
      EditorState.changeFilter.of((transaction) => !options.isReadOnly() || !transaction.docChanged || transaction.annotation(External) === true),
      settings.readOnly.of(readOnlyExtension(options.readOnly)),
      settings.label.of(labelExtension(options.label)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        if (update.transactions.some((transaction) => transaction.annotation(External) === true)) return;
        // `sliceDoc`, not `doc.toString()`: the latter always joins lines with a line feed.
        options.onEdit(update.state.sliceDoc());
      }),
    ],
  });
}
