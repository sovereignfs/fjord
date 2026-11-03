"use client";

import { type FormEvent, useState } from "react";
import { authClient } from "../client";
import { messageFor } from "../messages";
import { AuthButton, AuthError, AuthField, AuthForm, AuthNotice, Input } from "../../ui";

/** Name, email and password. With email verification on, the next thing is a link in the inbox. */
export function SignUpForm({ minLength, verifyEmail }: { minLength: number; verifyEmail: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({ name, email, password, callbackURL: "/" });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure));
      return;
    }
    if (verifyEmail) {
      setBusy(false);
      setSentTo(email);
      return;
    }
    window.location.assign("/");
  }

  if (sentTo) {
    return (
      <AuthNotice>We sent a link to {sentTo}. Open it to confirm your address and finish creating your account. It works for one hour.</AuthNotice>
    );
  }

  return (
    <AuthForm onSubmit={onSubmit}>
      <AuthField label="Name">{(field) => <Input {...field} name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}</AuthField>
      <AuthField label="Email">
        {(field) => <Input {...field} type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />}
      </AuthField>
      <AuthField label="Password" hint={`At least ${minLength} characters. A few random words is a good one.`}>
        {(field) => (
          <Input
            {...field}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={minLength}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        )}
      </AuthField>
      {error ? <AuthError>{error}</AuthError> : null}
      <AuthButton type="submit" loading={busy}>
        Create account
      </AuthButton>
    </AuthForm>
  );
}
