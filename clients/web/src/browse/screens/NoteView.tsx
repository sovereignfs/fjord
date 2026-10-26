"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft, sendDraft } from "../../working/client";
import { DraftSaver, type SaverStatus } from "../../working/saver";

/** The draft the page found for this note: its text and the version of the note it was started from. */
export interface DraftOfNote {
  content: string;
  baseBlob: string;
}

/**
 * A note in the note editor, kept as a draft as it is edited (ROADMAP 1b.2, 1b.8). Nothing typed here goes to the
 * repository: the text is sent to the server a moment after the last change (`DraftSaver`), where it waits until a
 * version is saved (1b.9). Closing the page and opening it again finds the draft, and says so.
 *
 * The editor is given the text it starts with and never again: what is on screen is the editor's, and what the saver
 * has is told of each change. Leaving the page sends what is waiting, and a text that could not be kept is not left
 * without a warning.
 */
export function NoteView({ connectionId, path, label, text, blob, draft }: { connectionId: number; path: string; label: string; text: string; blob: string; draft: DraftOfNote | null }) {
  const start = draft?.content ?? text;
  const base = draft?.baseBlob ?? blob;
  const saver = useMemo(() => new DraftSaver({ initial: start, send: (content) => sendDraft(connectionId, path, base, content) }), [connectionId, path, start, base]);
  const [status, setStatus] = useState<SaverStatus>(saver.status);
  // Whether the server holds a draft of this note: it did, or something has been kept since.
  const [hasDraft, setHasDraft] = useState(draft !== null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);

  useEffect(() => {
    const stop = saver.subscribe((next) => {
      setStatus(next);
      if (next.state === "kept") setHasDraft(true);
    });
    const leaving = () => {
      void saver.flush();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    // A text that is waiting is sent as the page goes; one that could not be sent is the only one to ask about.
    const warn = (event: BeforeUnloadEvent) => {
      const trouble = saver.status.state === "retrying" || saver.status.state === "stopped" || saver.status.state === "refused";
      if (trouble && saver.unsaved) event.preventDefault();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", warn);
      stop();
      void saver.flush(); // the person went to another page of the app
    };
  }, [saver]);

  async function discard() {
    setDiscarding(true);
    setDiscardFailed(false);
    saver.dispose();
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setDiscarding(false);
    setDiscardFailed(true);
  }

  const changedSince = draft !== null && draft.baseBlob !== blob;
  return (
    <div>
      {draft && !changedSince ? (
        <div className={styles.notice}>
          <Alert variant="info" heading="Your changes were kept">
            These are changes you made earlier and have not saved as a version. They are kept on this server, not in the repository.
          </Alert>
        </div>
      ) : null}
      {changedSince ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading="This note has changed since you started editing it">
            Your changes are kept as you left them. Someone changed the note in the repository meanwhile; bringing the two together comes in a later version. Until then you can keep editing your changes, or discard them to see the note as it is now.
          </Alert>
        </div>
      ) : null}
      <NoteEditor aria-label={label} value={start} onChange={(next) => saver.change(next)} />
      <p className={styles.itemMeta} role="status" aria-live="polite" data-testid="draft-status">
        {describe(status, hasDraft)}
      </p>
      {status.state === "refused" || status.state === "stopped" ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Your changes are not being kept">
            {status.message}
          </Alert>
        </div>
      ) : null}
      {hasDraft ? (
        <div>
          {discardFailed ? (
            <div className={styles.notice}>
              <Alert variant="error">Could not discard the changes. Try again.</Alert>
            </div>
          ) : null}
          {confirming ? (
            <p>
              Discard everything you changed in this note?{" "}
              <Button variant="destructive" size="sm" onClick={discard} loading={discarding}>
                Yes, discard
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={discarding}>
                Keep editing
              </Button>
            </p>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              Discard changes
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function describe(status: SaverStatus, hasDraft: boolean): string {
  switch (status.state) {
    case "idle":
      return hasDraft ? "" : "No changes yet. What you type is kept as a draft.";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Saving…";
    case "kept":
      return "Changes kept as a draft.";
    case "retrying":
      return "Could not keep your changes. Trying again…";
    case "refused":
    case "stopped":
      return "Changes are not being kept.";
  }
}
