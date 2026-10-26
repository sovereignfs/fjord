// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { forwardRef, useEffect, useRef, useState } from "react";
import { textQuoteAnchor } from "./anchor.js";
import { useNameGate } from "./name-gate.js";
import { PlainText, type Selection } from "./PlainText.js";
import type { DocumentEditorProps, EditorHandle, ThreadMark } from "./types.js";

/**
 * Edits a document (`*.fj.md`): the Markdown body, with the person's `role` deciding what they may do, comments through
 * the app's adapter, and a display name asked for before an anonymous person's first edit or comment (DESIGN.md §10,
 * §13). The core behind it is a plain text area until ROADMAP 1b.3 puts MDXEditor there.
 */
export const DocumentEditor = forwardRef<EditorHandle, DocumentEditorProps>(function DocumentEditor(
  { value, onChange, role, comments, onNeedName, className, "aria-label": label },
  ref,
) {
  const ensureNamed = useNameGate(onNeedName);
  const selection = useRef<Selection>({ start: 0, end: 0 });
  const [hasSelection, setHasSelection] = useState(false);
  const [threads, setThreads] = useState<readonly ThreadMark[]>(() => comments?.threads() ?? []);

  useEffect(() => {
    if (!comments) {
      setThreads([]);
      return;
    }
    setThreads(comments.threads());
    return comments.subscribe(() => setThreads(comments.threads()));
  }, [comments]);

  const marked = threads.filter((thread) => !thread.outdated).length;
  const canComment = role !== "view" && comments !== undefined;

  async function comment() {
    if (!comments || !(await ensureNamed())) return;
    try {
      comments.create(textQuoteAnchor(value, selection.current.start, selection.current.end));
    } catch (error) {
      // Nothing is selected any more: there is nothing to comment on.
      if (!(error instanceof RangeError)) throw error;
    }
  }

  return (
    <div className={["fe-editor", "fe-document", className].filter(Boolean).join(" ")} data-role={role}>
      {canComment ? (
        <div className="fe-toolbar" role="toolbar" aria-label="Comments">
          <button type="button" className="fe-button" disabled={!hasSelection} onClick={() => void comment()}>
            Comment on selection
          </button>
        </div>
      ) : null}
      <PlainText
        ref={ref}
        value={value}
        editable={role === "edit"}
        onEdit={(text) => {
          void (async () => {
            if (await ensureNamed()) onChange?.(text);
          })();
        }}
        onSelection={(next) => {
          selection.current = next;
          setHasSelection(next.end > next.start);
        }}
        aria-label={label}
      />
      {comments ? (
        <p className="fe-status" aria-live="polite">
          {marked === 1 ? "1 comment thread" : `${marked} comment threads`}
        </p>
      ) : null}
    </div>
  );
});
