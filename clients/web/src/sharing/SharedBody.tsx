"use client";

import { DocumentEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { GuestEditor } from "./GuestEditor";

/**
 * A document shared with someone (ROADMAP 1c.2, 1c.3, 1c.6): to be read, in the document editor with the `view` role, which cannot change
 * it, or, for a link that may edit, to be edited under a name the person gives (`GuestEditor`). The header is not in it, as for its owner.
 */
export function SharedBody({ title, body, docId, editable }: { title: string; body: string; docId: string; editable: boolean }) {
  if (editable) return <GuestEditor docId={docId} title={title} body={body} />;
  return <DocumentEditor aria-label={title} role="view" value={body} />;
}
