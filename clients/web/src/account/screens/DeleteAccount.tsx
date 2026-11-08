'use client';

import { type FormEvent, useState } from 'react';
import { ActionDialog } from '../../browse/screens/ActionDialog';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import styles from '../../auth/screens/AccountShell.module.css';

/**
 * Deleting the account (research 0002, G3): what will go, said in full, then the address typed out and the password where there is one (`src/account/http.ts`). It is drawn in *Profile*. Keys are not
 * touched: an identity kept in this browser is what opens files in a git repository that outlive this account, so it is for the person to remove, and it says so.
 */
export function DeleteAccount({
  email,
  hasPassword,
  onServer,
  inGit,
}: {
  email: string;
  hasPassword: boolean;
  /** Repositories kept only on this server, which are deleted for good. */ onServer: string[];
  /** How many git repositories are connected, which are left as they are. */ inGit: number;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm, ...(hasPassword ? { password } : {}) }),
      });
      if (response.ok) {
        // A full navigation: there is no session now, and every page will say so.
        window.location.assign('/');
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? 'Your account was not deleted. Try again.');
    } catch {
      setError('Could not reach this server. Nothing was deleted. Try again.');
    }
    setBusy(false);
  }

  const ready =
    confirm.trim().toLowerCase() === email.toLowerCase() && (!hasPassword || password !== '');
  return (
    <div className={styles.group}>
      <h2>Delete your account</h2>
      <p className={styles.hint}>This cannot be undone.</p>
      <div>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      </div>
      <ActionDialog
        open={open}
        onClose={busy ? () => undefined : () => setOpen(false)}
        title="Delete your account"
      >
        <form
          onSubmit={(event) => void onSubmit(event)}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sv-space-3)' }}
          aria-label="Delete your account"
        >
          {error ? <Alert variant="error">{error}</Alert> : null}
          <ul style={{ margin: 0, paddingLeft: '1.25em', lineHeight: 1.5 }}>
            {onServer.length > 0 ? (
              <li>
                <strong>
                  {onServer.length === 1
                    ? `${onServer[0]}, which is kept only on this server, is deleted for good`
                    : `${onServer.join(', ')}, which are kept only on this server, are deleted for good`}
                  .
                </strong>{' '}
                To keep {onServer.length === 1 ? 'it' : 'them'}, move{' '}
                {onServer.length === 1 ? 'it' : 'them'} to git first, from{' '}
                {onServer.length === 1 ? 'its' : 'their'} settings.
              </li>
            ) : null}
            {inGit > 0 ? (
              <li>
                {inGit === 1
                  ? 'The git repository you connected is left as it is'
                  : `The ${inGit} git repositories you connected are left as they are`}
                : only Fjord&apos;s access to {inGit === 1 ? 'it' : 'them'}, and unsaved drafts, go.
              </li>
            ) : null}
            <li>
              What you shared and published stops working, and what others shared with you goes from
              your list.
            </li>
            <li>
              Your comments on other people&apos;s documents are deleted. One that others answered
              stays, as &ldquo;This comment was deleted&rdquo;.
            </li>
            <li>
              An encryption identity in this browser stays here, because it may be what opens your
              files. Remove it under Security if you want it gone.
            </li>
          </ul>
          <FormField label={`Type ${email} to confirm`} required>
            {(field) => (
              <Input
                {...field}
                name="confirm"
                autoComplete="off"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
              />
            )}
          </FormField>
          {hasPassword ? (
            <FormField label="Your password" required>
              {(field) => (
                <Input
                  {...field}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              )}
            </FormField>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--sv-space-2)' }}>
            <Button type="submit" variant="destructive" loading={busy} disabled={!ready}>
              Delete my account
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      </ActionDialog>
    </div>
  );
}
