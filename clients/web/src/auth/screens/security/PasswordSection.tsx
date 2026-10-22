"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../../client";
import { messageFor } from "../../messages";
import { Alert, Button, FormField, Input } from "../../../ui";
import styles from "../screens.module.css";

export function PasswordSection({ minLength }: { minLength: number }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    // Changing a password is how someone who thinks theirs is out ends other people's use of it,
    // so every other session ends too.
    const { error: failure } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (failure) {
      setError(messageFor(failure));
      return;
    }
    setCurrent("");
    setNext("");
    setDone(true);
  }

  return (
    <section className={styles.section} aria-labelledby="password-title">
      <h2 id="password-title">Password</h2>
      <p>Changing it signs you out everywhere else.</p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {done ? (
        <div className={styles.notice}>
          <Alert variant="success">Your password is changed, and your other sessions are signed out.</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit} style={{ marginTop: 0 }}>
        <FormField label="Current password" required>
          {(field) => <Input {...field} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />}
        </FormField>
        <FormField label="New password" hint={`At least ${minLength} characters.`} required>
          {(field) => <Input {...field} type="password" autoComplete="new-password" minLength={minLength} value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
}
