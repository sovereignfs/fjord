"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft } from "../../working/client";

/**
 * A draft of a note that is no longer in the repository (ROADMAP 1b.10): it was deleted or moved from another tool. The
 * changes are not lost, and are shown, only to be read, so that they can be copied out; the only thing to do is to throw
 * them away. Making the note again from them comes with creating notes (1b.7).
 */
export function DeletedUpstream({ connectionId, path, label, text }: { connectionId: number; path: string; label: string; text: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    setBusy(true);
    setError(null);
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setError("Could not discard the changes. Try again.");
    setBusy(false);
  }

  return (
    <div>
      <div className={styles.notice}>
        <Alert variant="warning" heading="This note is no longer in the repository">
          It was deleted or moved from another device or tool. Your unsaved changes to it are kept and shown below, so that you can copy them out.
        </Alert>
      </div>
      <NoteEditor aria-label={`Your unsaved changes to ${label}`} value={text} readOnly />
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {confirming ? (
        <p>
          Discard these changes?{" "}
          <Button variant="destructive" size="sm" onClick={discard} loading={busy}>
            Yes, discard
          </Button>{" "}
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
            Keep them
          </Button>
        </p>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Discard changes
        </Button>
      )}
    </div>
  );
}
