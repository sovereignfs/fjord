// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Story } from "@ladle/react";
import { useMemo, useState } from "react";
import { DocumentEditor } from "../src/index.js";
import "../src/styles.css";
import { SAMPLE_DOCUMENT, demoComments } from "./samples.js";

export const Edit: Story = () => {
  const [body, setBody] = useState(SAMPLE_DOCUMENT);
  return <DocumentEditor aria-label="Document" role="edit" value={body} onChange={setBody} />;
};

export const View: Story = () => <DocumentEditor aria-label="Document" role="view" value={SAMPLE_DOCUMENT} />;

/** Select some text and ask to comment: the app's adapter gets the anchor, and the thread count follows. */
export const Comment: Story = () => {
  const comments = useMemo(() => demoComments(), []);
  return <DocumentEditor aria-label="Document" role="comment" value={SAMPLE_DOCUMENT} comments={comments} />;
};

/** A person with no account is asked for a name before their first edit; here by a browser dialog. */
export const AnonymousEditor: Story = () => {
  const [body, setBody] = useState(SAMPLE_DOCUMENT);
  return <DocumentEditor aria-label="Document" role="edit" value={body} onChange={setBody} onNeedName={async () => window.confirm("Edit as “Guest”?")} />;
};

/** A client dresses the editor in its own palette by setting custom properties; nothing else. */
export const Themed: Story = () => {
  const [body, setBody] = useState(SAMPLE_DOCUMENT);
  return (
    <div
      style={
        {
          "--fe-color-text": "#f5f2ea",
          "--fe-color-surface": "#1e2a2f",
          "--fe-color-border": "#4b5f66",
          "--fe-color-accent": "#e8b04a",
          "--fe-color-accent-text": "#1e2a2f",
          "--fe-radius": "0.75rem",
          padding: "1rem",
          background: "#12191c",
        } as React.CSSProperties
      }
    >
      <DocumentEditor aria-label="Document" role="edit" value={body} onChange={setBody} />
    </div>
  );
};
