"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "../ui";
import styles from "../auth/screens/screens.module.css";
import { sendIdentify } from "../files/client";

/**
 * Sharing a file that has no identifier (DESIGN.md §9, §12; ROADMAP 3e.3, RFC 0002). A share is of a Doc by its `id`, so that it keeps working when the file
 * is renamed or moved; a Markdown file written by another tool has none, and Fjord never adds one because a file was opened or edited. So the person is asked,
 * in words, what will be written: a few lines at the top of the file, in one commit, nothing else changed. On yes the page goes to the file's address by `id`,
 * where the sharing controls are. Unsaved changes are saved as a version first, or discarded: the commit is made on the version they looked at.
 */
export function IdentifyAndShare({ connectionId, path, blob, hasDraft }: { connectionId: number; path: string; blob: string; hasDraft: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function agree() {
    setBusy(true);
    setError(null);
    const made = await sendIdentify(connectionId, { path, blob });
    if (made.ok) {
      router.push(`/d/${made.docId}`);
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  return (
    <details className={styles.itemMeta} data-testid="identify-panel">
      <summary>Sharing</summary>
      <p>This file has no identifier, so it cannot be shared yet.</p>
      {hasDraft ? (
        <p>You have changes that are not saved as a version. Save a version of them, or discard them, first: the identifier is added to the version in the repository.</p>
      ) : asking ? (
        <>
          <p>
            Sharing adds an identifier to the file&apos;s header, a few lines at the top, so that a link to it keeps working if it is renamed or moved. It is one commit to the
            repository; the rest of the file is not changed.
          </p>
          {error ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="Nothing was changed">
                {error}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button type="button" loading={busy} onClick={() => void agree()}>
              Add the identifier and share
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => (setAsking(false), setError(null))}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(true)}>
          Share this file…
        </Button>
      )}
    </details>
  );
}
