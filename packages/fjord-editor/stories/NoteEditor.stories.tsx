// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Story } from "@ladle/react";
import { useState } from "react";
import { NoteEditor } from "../src/index.js";
import "../src/styles.css";
import { SAMPLE_NOTE } from "./samples.js";

export const Edit: Story = () => {
  const [text, setText] = useState(SAMPLE_NOTE);
  return <NoteEditor aria-label="Note" value={text} onChange={setText} />;
};

export const ReadOnly: Story = () => <NoteEditor aria-label="Note" value={SAMPLE_NOTE} readOnly />;
