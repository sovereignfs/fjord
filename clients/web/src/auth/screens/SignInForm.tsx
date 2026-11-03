"use client";

import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { AuthButton, AuthDivider, AuthError, AuthField, AuthFooter, AuthForm, AuthLink, AuthNotice, Input } from "../../ui";

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
  instanceName,
}: {
  local?: { canReset: boolean; canSignUp: boolean };
  sovereign: boolean;
  notice?: string;
  /** What went wrong on the way back from Sovereign, if anything. */
  initialError?: string;
  instanceName: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState<"password" | "passkey" | "sovereign" | null>(null);
  // Known only in the browser, so it is read after the first render, never during it.
  const [passkeysSupported, setPasskeysSupported] = useState(false);

  useEffect(() => setPasskeysSupported(typeof window.PublicKeyCredential === "function"), []);

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
    window.location.assign("/open");
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
    window.location.assign("/open");
  }

  async function onSovereign(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setBusy("sovereign");
    setError(null);
    // On success the browser is sent to Sovereign, so there is nothing to do after the call;
    // a person who comes back with a failure lands on this page again with the reason.
    const { error: failure } = await authClient.signIn.social({ provider: "sovereign", callbackURL: "/open", errorCallbackURL: "/sign-in" });
    if (failure) {
      setBusy(null);
      setError(messageFor(failure, "Signing in with Sovereign did not work. Try again."));
    }
  }

  const sovereignButton = (
    <AuthButton type={local ? "button" : "submit"} variant={local ? "secondary" : "primary"} onClick={local ? () => void onSovereign() : undefined} loading={busy === "sovereign"} disabled={busy !== null}>
      Sign in with Sovereign
    </AuthButton>
  );

  return (
    <>
      {notice ? <AuthNotice>{notice}</AuthNotice> : null}
      {local ? (
        <>
          <AuthForm onSubmit={(event) => void onSubmit(event)}>
            <AuthField label="Email">
              {(field) => (
                <Input {...field} type="email" name="email" autoComplete="username webauthn" required disabled={busy !== null} value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
            </AuthField>
            <AuthField label="Password" aside={local.canReset ? <a href="/forgot-password">Forgot password?</a> : undefined}>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  name="password"
                  autoComplete="current-password webauthn"
                  required
                  disabled={busy !== null}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </AuthField>
            {error ? <AuthError>{error}</AuthError> : null}
            <AuthButton type="submit" loading={busy === "password"} disabled={busy !== null}>
              Sign in
            </AuthButton>
          </AuthForm>
          {passkeysSupported ? (
            <>
              <AuthDivider />
              <AuthButton variant="secondary" onClick={() => void onPasskey()} loading={busy === "passkey"} disabled={busy !== null}>
                Sign in with a passkey
              </AuthButton>
            </>
          ) : null}
          {sovereign ? (
            <>
              <AuthDivider />
              {sovereignButton}
            </>
          ) : null}
          {local.canSignUp ? (
            <AuthFooter>
              New to {instanceName}? <AuthLink href="/sign-up">Create account</AuthLink>
            </AuthFooter>
          ) : null}
        </>
      ) : sovereign ? (
        <AuthForm onSubmit={(event) => void onSovereign(event)}>
          {error ? <AuthError>{error}</AuthError> : null}
          {sovereignButton}
        </AuthForm>
      ) : null}
    </>
  );
}
