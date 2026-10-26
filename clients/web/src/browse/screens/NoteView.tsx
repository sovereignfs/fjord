"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";

/**
 * A note in the note editor (ROADMAP 1b.2). Read-only for now: saving a change is working copies and versions (1b.8,
 * 1b.9), and an editor that accepts text it cannot keep would be a trap. The editor is the package's, through its
 * interface and nothing else; its look comes from the design system's tokens (`app/globals.css`).
 */
export function NoteView({ text, label }: { text: string; label: string }) {
  return <NoteEditor aria-label={label} value={text} readOnly />;
}
