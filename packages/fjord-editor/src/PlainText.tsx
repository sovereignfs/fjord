// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { forwardRef, useImperativeHandle, useRef } from "react";
import type { EditorHandle } from "./types.js";

export interface Selection {
  start: number;
  end: number;
}

interface PlainTextProps {
  value: string;
  /** False: the text can be read, selected and copied, and not changed. */
  editable: boolean;
  /** Called with the whole new text, for a change the person made. */
  onEdit: (text: string) => void;
  onSelection?: (selection: Selection) => void;
  "aria-label"?: string | undefined;
}

/**
 * The text surface of both editors for now: a plain text area. It stands in for the real cores (CodeMirror for notes,
 * MDXEditor for documents, ROADMAP 1b.2 and 1b.3) behind the same interface, so the app and the tests can be written
 * against the interface now. It is **not** byte-faithful: a browser's text area turns every line ending into a
 * line feed, which is one reason the note editor will not be one.
 */
export const PlainText = forwardRef<EditorHandle, PlainTextProps>(function PlainText({ value, editable, onEdit, onSelection, "aria-label": label }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  return (
    <textarea
      ref={area}
      className="fe-text"
      value={value}
      readOnly={!editable}
      aria-readonly={!editable}
      aria-label={label}
      spellCheck
      onChange={(event) => {
        if (editable) onEdit(event.currentTarget.value);
      }}
      onSelect={(event) => onSelection?.({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })}
    />
  );
});
