"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "./screens.module.css";

/** Ask for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (failure) setError(messageFor(failure));
    else setSent(true);
  }

  if (sent) {
    return (
      <Alert variant="success" heading="Check your email">
        If there is an account for {email}, we sent a link to choose a new password. It works for one hour.
      </Alert>
    );
  }

  return (
    <>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit}>
        <FormField label="Email" required>
          {(field) => <Input {...field} type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />}
        </FormField>
        <Button type="submit" size="lg" loading={busy}>
          Send the link
        </Button>
      </form>
    </>
  );
}

/** Choose a new password, with the token from the emailed link. */
export function ResetPasswordForm({ token, minLength }: { token: string; minLength: number }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure));
      return;
    }
    window.location.assign("/sign-in?reset=1");
  }

  return (
    <>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit}>
        <FormField label="New password" hint={`At least ${minLength} characters.`} required>
          {(field) => (
            <Input {...field} type="password" name="password" autoComplete="new-password" minLength={minLength} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          )}
        </FormField>
        <Button type="submit" size="lg" loading={busy}>
          Set the new password
        </Button>
      </form>
    </>
  );
}
