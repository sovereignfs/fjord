"use client";

import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { type DeleteTarget, sendDelete } from "../../files/client";
import { rememberUndo } from "../../files/undo";
import { repositoryHref } from "../links";

/**
 * Delete a note, a document or a folder (ROADMAP 1b.12), after asking: the confirmation names what will go, and for a folder
 * how many files. The page sends the version it showed (the file's blob, the folder's file count), so that only what was
 * confirmed is deleted; if it changed since, the page is read again. Nothing is lost for good: the files stay in the
 * repository's history, and the next page offers Undo.
 */
export function DeleteButton({
  connectionId,
  vault,
  target,
  name,
  goTo,
}: {
  connectionId: number;
  vault: string;
  target: DeleteTarget;
  /** What the person calls it. */
  name: string;
  /** Where to go after: the folder it was in. */
  goTo: string[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; lookAgain: boolean } | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const done = await sendDelete(connectionId, vault, target);
    if (done.ok) {
      try {
        rememberUndo(window.sessionStorage, connectionId, { ids: done.deletions, label: name });
      } catch {
        // No storage: there is no Undo, and Recently deleted has it.
      }
      window.location.assign(repositoryHref(connectionId, ...goTo));
      return;
    }
    setError({ message: done.message, lookAgain: done.lookAgain });
    setBusy(false);
  }

  const what = target.type === "folder" ? `the folder “${name}” and the ${target.files === 1 ? "1 file" : `${target.files} files`} in it` : `“${name}”`;
  return (
    <div>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was deleted">
            {error.message}{" "}
            {error.lookAgain ? (
              <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                Look again
              </Button>
            ) : null}
          </Alert>
        </div>
      ) : null}
      {confirming ? (
        <p>
          Delete {what}? It stays in the repository&apos;s history, and you can put it back from Recently deleted.{" "}
          <Button variant="destructive" size="sm" onClick={remove} loading={busy}>
            Yes, delete
          </Button>{" "}
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
        </p>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          {target.type === "folder" ? "Delete folder" : "Delete"}
        </Button>
      )}
    </div>
  );
}
