'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert, Button, FormField, Input, SegmentedControl } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';
import own from '../../connections/screens/ConnectForm.module.css';

type Kind = 'drive' | 'journal';

const BLURB: Record<Kind, string> = {
  drive: 'A place for notes and documents, in folders. It starts with one vault and a first note.',
  journal: 'One entry a day, newest first. It starts with one vault for the entries.',
};

/**
 * Make a repository on this server (ROADMAP 3i): a name and a kind. It is kept here until it is connected to a git repository, which
 * moves its files there; until then it is within the account's limits, and what the server answers when one is reached is shown as it is.
 */
export function NewRepositoryForm({
  heading = 'Create a repository',
  onCreated,
}: {
  heading?: string;
  onCreated?: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('drive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/connections/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
        connection?: { address: string };
      } | null;
      if (!response.ok || !body?.connection) {
        setError(body?.error?.message ?? 'The repository was not created. Try again.');
        return;
      }
      setName('');
      onCreated?.();
      router.push(`/${body.connection.address}`);
      router.refresh();
    } catch {
      setError('Could not reach this server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="create-title">
      <h2 id="create-title">{heading}</h2>
      <div className={own.guide}>
        <Alert variant="info">
          It is kept on this server, with a limit for each person, until you connect it to a git
          repository. Connecting moves everything there and removes it from the server. Until then,
          nothing of it is backed up anywhere else.
        </Alert>
      </div>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={own.form} onSubmit={onSubmit}>
        <FormField label="Name" required>
          {(field) => (
            <Input
              {...field}
              name="name"
              placeholder="Notes"
              autoComplete="off"
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          )}
        </FormField>
        <FormField label="Kind" hint={BLURB[kind]}>
          {() => (
            <SegmentedControl<Kind>
              aria-label="Kind"
              value={kind}
              onChange={setKind}
              options={[
                { label: 'Drive', value: 'drive' },
                { label: 'Journal', value: 'journal' },
              ]}
            />
          )}
        </FormField>
        <div className={own.actions}>
          <Button type="submit" loading={busy}>
            Create
          </Button>
        </div>
      </form>
    </section>
  );
}
