"use client";

import { DocumentEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import type { Role } from "../access/policy";
import { useComments } from "../comments/Comments";
import { GuestEditor } from "./GuestEditor";

/**
 * A document shared with someone (ROADMAP 1c.2, 1c.3, 1c.6, 1d.1): to be read, in the document editor, with the comments beside it; or, for a
 * link that may edit, to be edited under a name the person gives (`GuestEditor`). Whether they may comment is their role's: `view` reads the
 * document and its comments, `comment` also starts threads and replies. `guest` is someone who came by a link, who is asked for a name before
 * they write. The header is not in it, as for its owner.
 */
export function SharedBody({ title, body, docId, editable, role, guest }: { title: string; body: string; docId: string; editable: boolean; role: Role; guest: boolean }) {
  if (editable) return <GuestEditor docId={docId} title={title} body={body} />;
  return <ReadAndComment title={title} body={body} docId={docId} role={role} guest={guest} />;
}

function ReadAndComment({ title, body, docId, role, guest }: { title: string; body: string; docId: string; role: Role; guest: boolean }) {
  const { adapter, onNeedName, panel } = useComments(docId, { guest });
  return (
    <>
      <DocumentEditor aria-label={title} role={role === "view" ? "view" : "comment"} value={body} comments={adapter} onNeedName={onNeedName} />
      {panel}
    </>
  );
}
