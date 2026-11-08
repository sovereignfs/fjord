'use client';

import { type FormEvent, useState } from 'react';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import { useConfirm } from '../../ui/useConfirm';
import styles from '../../auth/screens/screens.module.css';
import own from '../../connections/screens/ConnectForm.module.css';

/**
 * Connect a repository that is kept on this server to a git repository (ROADMAP 3i): the same address and token as connecting one, and what
 * follows is `src/local/sync.ts`'s: the files are added to it in one commit, checked to be there, and only then is the server's copy removed.
 * A repository that already has files by the same names is never changed: the server says which and nothing is written.
 */
export function SyncForm({ id, name }: { id: number; name: string }) {
  const [ask, asking] = useConfirm();
  const [moved, setMoved] = useState(false);
  const [repository, setRepository] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !(await ask({
        message: `Move “${name}” to ${repository.trim() || 'that repository'}? Its files are added to it in one commit, and once they are there this server's copy is deleted.`,
        confirm: 'Move it',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${id}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository, token }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setError(
          body?.error?.message ??
            'The repository was not moved. Nothing was deleted from this server. Try again.',
        );
        return;
      }
      setToken('');
      setMoved(true);
    } catch {
      setError('Could not reach this server. Nothing was deleted. Try again.');
    } finally {
      setBusy(false);
    }
  }

  // Said here, in the dialog, and only then is the page read again: what it reads next has no form to say it from.
  if (moved) {
    return (
      <Alert variant="success" heading="Moved to git">
        <p style={{ margin: 0 }}>
          Its files are in {repository.trim()}, and this server&apos;s copy is deleted. Drafts,
          shares, comments and addresses stayed.
        </p>
        <p style={{ margin: 'var(--sv-space-2) 0 0' }}>
          <Button size="sm" onClick={() => window.location.reload()}>
            Open it
          </Button>
        </p>
      </Alert>
    );
  }
  return (
    <>
      {asking}
      <form
        className={own.form}
        onSubmit={onSubmit}
        aria-label="Connect this repository to git"
        style={{ marginTop: 0 }}
      >
        <p className={styles.itemMeta}>
          Use a git repository that already exists, with a fine-grained token that has{' '}
          <strong>Contents: Read and write</strong> for it. Nothing in it is changed or removed: the
          files are added alongside, in one commit. If it has a file by one of these names, nothing
          is copied.
        </p>
        {error ? (
          <div className={styles.notice}>
            <Alert variant="error" heading="Nothing was deleted from this server">
              {error}
            </Alert>
          </div>
        ) : null}
        <FormField label="Git repository" hint="Its address, or owner/name." required>
          {(field) => (
            <Input
              {...field}
              name="repository"
              placeholder="https://github.com/you/notes"
              autoComplete="off"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <FormField label="Access token" required>
          {(field) => (
            <Input
              {...field}
              type="password"
              name="token"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <div className={own.actions}>
          <Button type="submit" loading={busy}>
            Move to git
          </Button>
        </div>
      </form>
    </>
  );
}
