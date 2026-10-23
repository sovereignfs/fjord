"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/** Make this repository the one `/` opens. */
export function MakeDefaultButton({ id, label }: { id: number; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${id}/default`, { method: "POST" });
      if (!response.ok) {
        setError(`${label} was not made your default. Try again.`);
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
        Make this my default
      </Button>
    </>
  );
}
