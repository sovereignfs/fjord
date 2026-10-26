// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { forwardRef } from "react";
import { PlainText } from "./PlainText.js";
import type { EditorHandle, NoteEditorProps } from "./types.js";

/**
 * Edits a note (`*.md`): the Markdown source, as it is. Minimal on purpose, with no toolbar, no comments and no
 * sharing in phase 1 (DESIGN.md §10). The core behind it is a plain text area until ROADMAP 1b.2 puts CodeMirror
 * there, which is what makes an edit change only what the person changed.
 */
export const NoteEditor = forwardRef<EditorHandle, NoteEditorProps>(function NoteEditor({ value, onChange, readOnly = false, className, "aria-label": label }, ref) {
  return (
    <div className={["fe-editor", "fe-note", className].filter(Boolean).join(" ")} data-readonly={readOnly}>
      <PlainText ref={ref} value={value} editable={!readOnly} onEdit={(text) => onChange?.(text)} aria-label={label} />
    </div>
  );
});
