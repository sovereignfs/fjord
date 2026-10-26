// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Story } from "@ladle/react";
import { useState } from "react";
import { NoteEditor } from "../src/index.js";
import "../src/styles.css";
import { SAMPLE_DOCUMENT, SAMPLE_NOTE } from "./samples.js";

export const Edit: Story = () => {
  const [text, setText] = useState(SAMPLE_NOTE);
  return <NoteEditor aria-label="Note" value={text} onChange={setText} />;
};

export const ReadOnly: Story = () => <NoteEditor aria-label="Note" value={SAMPLE_NOTE} readOnly />;

/** The Markdown source, lightly marked up. Nothing is rewritten: what goes in comes out, line endings and all. */
export const Markdown: Story = () => {
  const [text, setText] = useState(SAMPLE_DOCUMENT);
  return <NoteEditor aria-label="Note" value={text} onChange={setText} />;
};

/** A note from a Windows tool: every line break is CRLF, and stays CRLF when you type. */
export const WindowsLineEndings: Story = () => {
  const [text, setText] = useState(SAMPLE_NOTE.replace(/\n/g, "\r\n"));
  return <NoteEditor aria-label="Note" value={text} onChange={setText} />;
};
