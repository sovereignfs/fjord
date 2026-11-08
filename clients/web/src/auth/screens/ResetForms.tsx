'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '../client';
import { messageFor } from '../messages';
import { AuthButton, AuthError, AuthField, AuthForm, AuthNotice, Input } from '../../ui';

/** Ask for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setBusy(false);
    if (failure) setError(messageFor(failure));
    else setSent(true);
  }

  if (sent) {
    return (
      <AuthNotice>
        If there is an account for {email}, we sent a link to choose a new password. It works for
        one hour.
      </AuthNotice>
    );
  }

  return (
    <AuthForm onSubmit={onSubmit}>
      <AuthField label="Email address">
        {(field) => (
          <Input
            {...field}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        )}
      </AuthField>
      {error ? <AuthError>{error}</AuthError> : null}
      <AuthButton type="submit" loading={busy}>
        Send reset link
      </AuthButton>
    </AuthForm>
  );
}

/** Choose a new password, with the token from the emailed link. */
export function ResetPasswordForm({ token, minLength }: { token: string; minLength: number }) {
  const [password, setPassword] = useState('');
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
    window.location.assign('/sign-in?reset=1');
  }

  return (
    <AuthForm onSubmit={onSubmit}>
      <AuthField label="New password" hint={`At least ${minLength} characters.`}>
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
        Set new password
      </AuthButton>
    </AuthForm>
  );
}
