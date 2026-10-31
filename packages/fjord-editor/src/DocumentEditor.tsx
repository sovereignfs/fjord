// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Suspense, forwardRef, lazy, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { textQuoteAnchor } from "./anchor.js";
import { type MarkedThread, caretAt, paintMarks, threadAt } from "./marks.js";
import { useNameGate } from "./name-gate.js";
import { NoteEditor } from "./NoteEditor.js";
import { offsetsOfSelectedText } from "./selection.js";
import type { DocumentEditorProps, EditorHandle, ThreadMark } from "./types.js";

// The visual editor is a large library, and only a document needs it: a page that opens a note never loads it.
const RichDocument = lazy(() => import("./rich/RichDocument.js").then((module) => ({ default: module.RichDocument })));

/**
 * Edits a document (`*.fj.md`): the Markdown body, with the person's `role` deciding what they may do, comments through
 * the app's adapter, and a display name asked for before an anonymous person's first edit or comment (DESIGN.md §10,
 * §13).
 *
 * It is a visual editor (MDXEditor) for the Markdown it can hold without changing what it means, and for any other it is
 * the Markdown itself, in the byte-faithful editor the notes use, with a notice saying so. Which one is decided on opening
 * the text, and again whenever the app sets a different one (`rich/meaning.ts`): the person never has a document
 * rewritten into something it was not. The package never touches the header; the app keeps it (DESIGN.md §9).
 */
export const DocumentEditor = forwardRef<EditorHandle, DocumentEditorProps>(function DocumentEditor(
  { value, onChange, role, comments, onNeedName, className, "aria-label": label },
  ref,
) {
  const ensureNamed = useNameGate(onNeedName);
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle>(null);
  const editable = role === "edit";
  /** The visual editor could not hold this text, so it is shown as Markdown. */
  const [asMarkdown, setAsMarkdown] = useState(false);
  /** Bumped to start the Markdown editor again from what the app holds, when an edit was not taken. */
  const [restarts, setRestarts] = useState(0);
  const [selected, setSelected] = useState("");
  const [threads, setThreads] = useState<readonly ThreadMark[]>(() => comments?.threads() ?? []);

  useImperativeHandle(ref, () => ({ focus: () => handle.current?.focus() }), []);

  useEffect(() => {
    if (!comments) {
      setThreads([]);
      return;
    }
    setThreads(comments.threads());
    return comments.subscribe(() => setThreads(comments.threads()));
  }, [comments]);

  // What is selected inside this editor, for "Comment on selection".
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const inside = selection !== null && selection.anchorNode !== null && container.current?.contains(selection.anchorNode);
      setSelected(inside ? selection.toString() : "");
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  /** An edit by the person: told to the app once they have a name, if they need one. Whether it was taken. */
  const edit = useCallback(
    async (text: string) => {
      if (!(await ensureNamed())) return false;
      onChange?.(text);
      return true;
    },
    [ensureNamed, onChange],
  );

  // The marks in the text (ROADMAP 1d.1): drawn over the rendered text of the visual editor, found again from each thread's anchor whenever
  // the threads or the text change, and a click on one tells the app which thread it is. The Markdown fallback is not marked.
  const ranges = useRef<ReadonlyMap<string, Range>>(new Map());
  useEffect(() => {
    const root = container.current;
    if (!root || !comments || asMarkdown) {
      ranges.current = new Map();
      return;
    }
    const open: MarkedThread[] = threads.filter((thread) => !thread.outdated).map((thread) => ({ id: thread.id, anchor: thread.anchor, resolved: thread.resolved }));
    let frame = 0;
    let clear = () => {};
    const paint = () => {
      frame = 0;
      const surface = root.querySelector('[role="textbox"]');
      clear();
      if (!surface) {
        ranges.current = new Map();
        clear = () => {};
        return;
      }
      const painted = paintMarks(surface, open, comments.active?.() ?? null);
      ranges.current = painted.ranges;
      clear = painted.clear;
      comments.anchored?.({ fates: painted.fates, reanchored: painted.reanchored });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    paint();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      clear();
      ranges.current = new Map();
    };
  }, [threads, comments, asMarkdown, value]);

  function chooseMark(event: React.MouseEvent) {
    if (!comments || ranges.current.size === 0) return;
    // A click that ends a drag across text is a selection, not a choice of a mark.
    if (document.getSelection()?.isCollapsed === false) return;
    const caret = caretAt(document, event.clientX, event.clientY);
    const id = caret ? threadAt(ranges.current, caret.node, caret.offset) : undefined;
    if (id !== undefined) comments.open(id);
  }

  const marked = threads.filter((thread) => !thread.outdated).length;
  const canComment = role !== "view" && comments !== undefined;
  const offsets = offsetsOfSelectedText(value, selected);

  async function comment() {
    if (!comments || !offsets || !(await ensureNamed())) return;
    try {
      comments.create(textQuoteAnchor(value, offsets[0], offsets[1]));
    } catch (error) {
      // Nothing is selected any more: there is nothing to comment on.
      if (!(error instanceof RangeError)) throw error;
    }
  }

  return (
    <div ref={container} className={["fe-editor", "fe-document", className].filter(Boolean).join(" ")} data-role={role} data-mode={asMarkdown ? "markdown" : "visual"} onClick={chooseMark}>
      {canComment ? (
        <div className="fe-toolbar" role="toolbar" aria-label="Comments">
          <button type="button" className="fe-button" disabled={offsets === null} onClick={() => void comment()}>
            Comment on selection
          </button>
        </div>
      ) : null}
      {asMarkdown ? (
        <>
          <p className="fe-notice" role="note">
            This document has Markdown the visual editor cannot keep exactly as written, so it is shown as Markdown.
          </p>
          <NoteEditor
            key={restarts}
            ref={handle}
            {...(label !== undefined ? { "aria-label": label } : {})}
            value={value}
            readOnly={!editable}
            onChange={(text) => {
              void edit(text).then((taken) => {
                // A person who declined to give a name has not changed the document: start again from what it is.
                if (!taken) setRestarts((count) => count + 1);
              });
            }}
          />
        </>
      ) : (
        <Suspense fallback={<p className="fe-status">Loading the editor…</p>}>
          <RichDocument ref={handle} value={value} editable={editable} aria-label={label} onEdit={edit} onUnsafe={() => setAsMarkdown(true)} />
        </Suspense>
      )}
      {comments ? (
        <p className="fe-status" aria-live="polite">
          {marked === 1 ? "1 comment thread" : `${marked} comment threads`}
        </p>
      ) : null}
    </div>
  );
});
