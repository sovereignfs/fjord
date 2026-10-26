"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/** Make this vault the one its repository opens on. */
export function ChooseVaultButton({ connectionId, vault, label }: { connectionId: number; vault: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/vault`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault }),
      });
      if (!response.ok) {
        setError(`${label} was not made the vault this repository opens on. Try again.`);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach this server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onClick} loading={busy}>
        Open this one first
      </Button>
    </>
  );
}
