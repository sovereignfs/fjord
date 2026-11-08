'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert, Button, FormField, Input } from '../../ui';

/** A new address for the account (research 0002, G4): the address and the password, and then either it has changed or a link is on its way to the address it has now (`src/account/http.ts`). */
export function ChangeEmail({ email }: { email: string }) {
  const router = useRouter();
  const [next, setNext] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch('/api/account/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: next, password }),
      });
      const body = (await response.json().catch(() => null)) as {
        result?: string;
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setError(body?.error?.message ?? 'Your address was not changed. Try again.');
      } else {
        setDone(
          body?.result === 'changed'
            ? `Your address is now ${next.trim().toLowerCase()}.`
            : `Check ${email} for a link to confirm the change. Until it is followed, your address stays as it is.`,
        );
        setNext('');
        setPassword('');
        // The menu and every page that says who is signed in read it from the session.
        router.refresh();
      }
    } catch {
      setError('Could not reach this server. Nothing was changed. Try again.');
    }
    setBusy(false);
  }

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sv-space-3)' }}
      aria-label="Change your address"
    >
      {error ? <Alert variant="error">{error}</Alert> : null}
      {done ? <Alert variant="success">{done}</Alert> : null}
      <FormField label="New address">
        {(field) => (
          <Input
            {...field}
            type="email"
            name="new-email"
            autoComplete="email"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
          />
        )}
      </FormField>
      <FormField label="Your password">
        {(field) => (
          <Input
            {...field}
            type="password"
            name="email-password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        )}
      </FormField>
      <div>
        <Button
          type="submit"
          variant="secondary"
          loading={busy}
          disabled={next.trim() === '' || password === ''}
        >
          Change address
        </Button>
      </div>
    </form>
  );
}
