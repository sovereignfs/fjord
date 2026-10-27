"use client";

import { DocumentEditor } from "fjord-editor";
import "fjord-editor/styles.css";

/**
 * A document shared with someone, to be read (ROADMAP 1c.2): the body in the document editor with the `view` role, which cannot
 * change it. Comments and editing come with the roles that allow them (1d, 1c.6). The header is not in it, as for its owner.
 */
export function SharedBody({ title, body }: { title: string; body: string }) {
  return <DocumentEditor aria-label={title} role="view" value={body} />;
}
