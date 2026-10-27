"use client";

import { useEffect, useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { sendRestore } from "../../files/client";
import { type UndoOffer, takeUndo } from "../../files/undo";

/**
 * "Deleted X. Undo" (ROADMAP 1b.12), on the page after a deletion: it puts back what was just deleted, where it was, and
 * never over anything. Said once. Recently deleted has the rest.
 */
export function UndoBanner({ connectionId }: { connectionId: number }) {
  const [offer, setOffer] = useState<UndoOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    try {
      setOffer(takeUndo(window.sessionStorage, connectionId) ?? null);
    } catch {
      // No storage, no offer.
    }
  }, [connectionId]);

  async function undo() {
    if (!offer) return;
    setBusy(true);
    setError(null);
    const done = await sendRestore(connectionId, offer.ids);
    if (done.ok) {
      setUndone(true);
      window.location.reload();
      return;
    }
    setError(done.message);
    setBusy(false);
  }

  if (!offer) return null;
  if (undone) return null;
  return (
    <div className={styles.notice}>
      <Alert variant="success" heading={`Deleted “${offer.label}”`}>
        It is still in the repository&apos;s history.{" "}
        <Button size="sm" variant="secondary" onClick={undo} loading={busy}>
          Undo
        </Button>{" "}
        <a href={`/deleted/${connectionId}`}>Recently deleted</a>
        {error ? <span role="alert"> {error}</span> : null}
      </Alert>
    </div>
  );
}
