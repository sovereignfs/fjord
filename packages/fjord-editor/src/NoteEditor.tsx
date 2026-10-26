// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EditorView } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { External, createState, labelExtension, lineSeparatorOf, minimalChange, readOnlyExtension, settings } from "./note-state.js";
import type { EditorHandle, NoteEditorProps } from "./types.js";

/**
 * Edits a note (`*.md`): the Markdown source, as it is (clients/web/DESIGN.md §10). Minimal on purpose: CodeMirror 6 with
 * light Markdown styling, no toolbar, no comments, no sharing in phase 1.
 *
 * **Byte-faithful.** What goes in comes out unchanged but for what the person changed: line endings (LF, or CRLF where
 * every line break is one), a byte order mark, trailing spaces, tabs and the absence of a final newline are all kept.
 * `onChange` is given the whole text, exactly.
 *
 * The editor holds the text while the person types and tells the app after each edit; the app's `value` is what the
 * editor starts with and what it is set to when it changes from outside (a change the editor then does not report).
 */
export const NoteEditor = forwardRef<EditorHandle, NoteEditorProps>(function NoteEditor({ value, onChange, readOnly = false, className, "aria-label": label }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  // What the editor needs to know at the moment something happens, without making a new editor for each render.
  const latest = useRef({ value, onChange, readOnly, label });
  latest.current = { value, onChange, readOnly, label };

  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: createState(latest.current.value, {
        readOnly: latest.current.readOnly,
        label: latest.current.label,
        isReadOnly: () => latest.current.readOnly,
        onEdit: (text) => latest.current.onChange?.(text),
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // The app set a different text.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.sliceDoc();
    if (current === value) return;
    if (lineSeparatorOf(value) !== lineSeparatorOf(current)) {
      // A different kind of line break is a different kind of document: start again rather than rewrite every line.
      editor.setState(createState(value, { readOnly, label, isReadOnly: () => latest.current.readOnly, onEdit: (text) => latest.current.onChange?.(text) }));
      return;
    }
    const change = minimalChange(current, value);
    if (change) editor.dispatch({ changes: change, annotations: External.of(true) });
  }, [value, readOnly, label]);

  useEffect(() => {
    view.current?.dispatch({ effects: [settings.readOnly.reconfigure(readOnlyExtension(readOnly)), settings.label.reconfigure(labelExtension(label))] });
  }, [readOnly, label]);

  return <div ref={host} className={["fe-editor", "fe-note", className].filter(Boolean).join(" ")} data-readonly={readOnly} />;
});
