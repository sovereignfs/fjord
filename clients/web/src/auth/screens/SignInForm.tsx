"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "./screens.module.css";

/**
 * The ways this instance offers: email and password or a passkey (two-factor, if the account has
 * it, is the next screen), and/or Sovereign, which takes the person away to sign in there and
 * brings them back.
 */
export function SignInForm({
  local,
  sovereign,
  notice,
  initialError,
}: {
  local?: { canReset: boolean; canSignUp: boolean };
  sovereign: boolean;
  notice?: string;
  /** What went wrong on the way back from Sovereign, if anything. */
  initialError?: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState<"password" | "passkey" | "sovereign" | null>(null);

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

  async function onSovereign() {
    setBusy("sovereign");
    setError(null);
    // On success the browser is sent to Sovereign, so there is nothing to do after the call;
    // a person who comes back with a failure lands on this page again with the reason.
    const { error: failure } = await authClient.signIn.social({ provider: "sovereign", callbackURL: "/", errorCallbackURL: "/sign-in" });
    if (failure) {
      setBusy(null);
      setError(messageFor(failure, "Signing in with Sovereign did not work. Try again."));
    }
  }

  const sovereignButton = sovereign ? (
    <div className={styles.form}>
      <Button variant={local ? "secondary" : "primary"} size="lg" onClick={onSovereign} loading={busy === "sovereign"} disabled={busy !== null}>
        Sign in with Sovereign
      </Button>
    </div>
  ) : null;

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
      {local ? (
        <>
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
            {local.canReset ? <a href="/forgot-password">Forgot your password?</a> : <span />}
            {local.canSignUp ? <a href="/sign-up">Create an account</a> : null}
          </div>
        </>
      ) : null}
      {local && sovereign ? <div className={styles.divider}>or</div> : null}
      {sovereignButton}
    </>
  );
}
