"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "./screens.module.css";

/** Email and password, or a passkey. Two-factor, if the account has it, is the next screen. */
export function SignInForm({ canReset, canSignUp, notice }: { canReset: boolean; canSignUp: boolean; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("password");
    setError(null);
    const { data, error: failure } = await authClient.signIn.email({ email, password });
    if (failure) {
      setBusy(null);
      setError(messageFor(failure));
      return;
    }
    // With two-factor on, the client has already sent the person to the code page.
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return;
    // A full navigation, not a client-side one: `/` is a different page now that there is a
    // session, and the server decides which.
    window.location.assign("/");
  }

  async function onPasskey() {
    setBusy("passkey");
    setError(null);
    const { error: failure } = await authClient.signIn.passkey();
    if (failure) {
      setBusy(null);
      setError(messageFor(failure, "Passkey sign-in did not work. Try your password instead."));
      return;
    }
    window.location.assign("/");
  }

  return (
    <>
      {notice ? (
        <div className={styles.notice}>
          <Alert variant="success">{notice}</Alert>
        </div>
      ) : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit} noValidate={false}>
        <FormField label="Email" required>
          {(field) => (
            <Input {...field} type="email" name="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy !== null} />
          )}
        </FormField>
        <FormField label="Password" required>
          {(field) => (
            <Input {...field} type="password" name="password" autoComplete="current-password webauthn" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy !== null} />
          )}
        </FormField>
        <Button type="submit" size="lg" loading={busy === "password"} disabled={busy !== null}>
          Sign in
        </Button>
      </form>
      <div className={styles.divider}>or</div>
      <div className={styles.form}>
        <Button variant="secondary" size="lg" onClick={onPasskey} loading={busy === "passkey"} disabled={busy !== null}>
          Sign in with a passkey
        </Button>
      </div>
      <div className={styles.links} style={{ marginTop: "var(--sv-space-5)" }}>
        {canReset ? <a href="/forgot-password">Forgot your password?</a> : <span />}
        {canSignUp ? <a href="/sign-up">Create an account</a> : null}
      </div>
    </>
  );
}
