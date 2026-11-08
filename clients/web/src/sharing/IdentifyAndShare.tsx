'use client';

import { useState } from 'react';
import { Alert, Button } from '../ui';
import { sendIdentify } from '../files/client';
import styles from './Sharing.module.css';

/**
 * The step before sharing a file that has no identifier (DESIGN.md §9, §12; ROADMAP 3e.3, RFC 0002), in the sharing dialog itself. A share is of a Doc by its `id`, so that it keeps working when the file
 * is renamed or moved; a Markdown file written by another tool has none, and Fjord never adds one because a file was opened or edited. So the person is told, in words, what will be written (a few
 * lines at the top of the file, in one commit, nothing else changed) next to the one button that does it, and no earlier step stands before it. On yes the dialog goes on to the sharing controls (`onMade`,
 * the file's new identifier). Unsaved changes are saved as a version first, or discarded: the commit is made on the version they looked at.
 */
export function IdentifyStep({
  connectionId,
  path,
  blob,
  hasDraft,
  onMade,
}: {
  connectionId: number;
  path: string;
  blob: string;
  hasDraft: boolean;
  onMade: (docId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function agree() {
    setBusy(true);
    setError(null);
    const made = await sendIdentify(connectionId, { path, blob });
    if (made.ok) {
      onMade(made.docId);
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  return (
    <div className={styles.step} data-testid="identify-panel">
      <div className={styles.stepIcon} aria-hidden>
        <span>#</span>
      </div>
      <h3 className={styles.stepTitle}>This file needs an identifier before it can be shared</h3>
      {hasDraft ? (
        <p className={styles.muted}>
          You have changes that are not saved as a version. Save a version of them, or discard them,
          first: the identifier is added to the version in the repository.
        </p>
      ) : (
        <>
          <p className={styles.muted}>
            It is a few lines at the top of the file&apos;s header, so that a link to it keeps
            working if the file is renamed or moved. It is one commit to the repository; the rest of
            the file is not changed.
          </p>
          {error ? (
            <Alert variant="error" heading="Nothing was changed">
              {error}
            </Alert>
          ) : null}
          <div className={styles.stepActions}>
            <Button type="button" loading={busy} onClick={() => void agree()}>
              Add the identifier and continue
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
