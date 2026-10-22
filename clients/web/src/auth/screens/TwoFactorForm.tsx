"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "./screens.module.css";

/** The second step of signing in: a code from the authenticator app, or a backup code. */
export function TwoFactorForm() {
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = code.replace(/\s/g, "");
    const { error: failure } = useBackup ? await authClient.twoFactor.verifyBackupCode({ code: trimmed }) : await authClient.twoFactor.verifyTotp({ code: trimmed });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure));
      return;
    }
    window.location.assign("/");
  }

  return (
    <>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit}>
        <FormField
          label={useBackup ? "Backup code" : "Code from your authenticator app"}
          hint={useBackup ? "Each backup code works once." : "Six digits. They change every 30 seconds."}
          required
          className={styles.codeInput}
        >
          {(field) => (
            <Input
              {...field}
              name="code"
              inputMode={useBackup ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <Button type="submit" size="lg" loading={busy}>
          Continue
        </Button>
      </form>
      <p className={styles.footer} style={{ marginTop: "var(--sv-space-5)" }}>
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setUseBackup(!useBackup);
            setCode("");
            setError(null);
          }}
        >
          {useBackup ? "Use my authenticator app" : "I cannot use my authenticator app"}
        </button>
      </p>
    </>
  );
}
