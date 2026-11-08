'use client';

import { type FormEvent, useState } from 'react';
import { authClient } from '../client';
import { messageFor } from '../messages';
import { recallNext } from '../next';
import {
  AuthButton,
  AuthCodeInput,
  AuthError,
  AuthField,
  AuthFooter,
  AuthForm,
  AuthLink,
  AuthLinkButton,
  Input,
} from '@sovereignfs/ui';

/** The second step of signing in: a code from the authenticator app, or a backup code. */
export function TwoFactorForm() {
  const [useBackup, setUseBackup] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const trimmed = code.replace(/\s/g, '');
    const { error: failure } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: trimmed })
      : await authClient.twoFactor.verifyTotp({ code: trimmed });
    if (failure) {
      setBusy(false);
      setError(messageFor(failure));
      return;
    }
    window.location.assign(recallNext() ?? '/open');
  }

  return (
    <>
      <AuthForm onSubmit={onSubmit}>
        {useBackup ? (
          <AuthField label="Backup code" hint="Each backup code works once.">
            {(field) => (
              <Input
                {...field}
                name="code"
                autoComplete="off"
                required
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the one field the person just opened this form to fill
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
            )}
          </AuthField>
        ) : (
          <AuthCodeInput
            label="Code from your authenticator app"
            value={code}
            onChange={setCode}
            disabled={busy}
            invalid={error !== null}
          />
        )}
        {error ? <AuthError>{error}</AuthError> : null}
        <AuthButton type="submit" loading={busy} disabled={!useBackup && code.length < 6}>
          Verify
        </AuthButton>
      </AuthForm>
      <AuthFooter>
        {useBackup ? 'Have your authenticator app? ' : 'Lost access to your authenticator? '}
        <AuthLinkButton
          onClick={() => {
            setUseBackup(!useBackup);
            setCode('');
            setError(null);
          }}
        >
          {useBackup ? 'Use the authenticator app instead' : 'Use a backup code'}
        </AuthLinkButton>
      </AuthFooter>
      <AuthFooter>
        <AuthLink href="/sign-in">Back to sign in</AuthLink>
      </AuthFooter>
    </>
  );
}
