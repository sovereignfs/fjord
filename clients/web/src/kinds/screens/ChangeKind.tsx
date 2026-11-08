'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert, Button } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';

type Choice = 'drive' | 'journal' | 'astro' | 'jekyll';

const LABELS: Record<Choice, string> = {
  drive: 'Drive',
  journal: 'Journal',
  astro: 'Site (Astro)',
  jekyll: 'Site (Jekyll)',
};

/**
 * A repository's kind, and changing it (ROADMAP 3a.3, spec §3.1): one commit of `fjord.json`, which the server makes and refuses, saying
 * why, when the repository does not keep the new kind's rules. Nothing else in the repository changes.
 */
export function ChangeKind({
  connectionId,
  kind,
  engine,
  serverSide = false,
}: {
  connectionId: number;
  kind: string;
  engine: string | null;
  /** Kept on this server: a site needs a git host to build and preview it, so it is not offered. */ serverSide?: boolean;
}) {
  const router = useRouter();
  const current: Choice | undefined =
    kind === 'ssg'
      ? engine === 'astro' || engine === 'jekyll'
        ? engine
        : undefined
      : kind === 'drive' || kind === 'journal'
        ? kind
        : undefined;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>(current ?? 'drive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      choice === 'astro' || choice === 'jekyll'
        ? { kind: 'ssg', engine: choice }
        : { kind: choice };
    try {
      const response = await fetch(`/api/connections/${connectionId}/kind`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const answer = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        setError(
          answer?.error?.message ?? 'The kind was not changed. Nothing was written. Try again.',
        );
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach this server. Nothing was written. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className={styles.itemMeta}>
        This repository is{' '}
        {current
          ? `a ${LABELS[current].toLowerCase()}`
          : `of the kind “${kind}”, which this version shows as a drive`}
        .{' '}
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Change its kind
        </Button>
      </p>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={onSubmit}
      aria-label="Change the repository's kind"
      style={{ marginTop: 0 }}
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
        <legend>What this repository is for</legend>
        {(Object.keys(LABELS) as Choice[])
          .filter((option) => !serverSide || option === 'drive' || option === 'journal')
          .map((option) => (
            <label key={option} style={{ display: 'block' }}>
              <input
                type="radio"
                name="kind"
                checked={choice === option}
                onChange={() => setChoice(option)}
              />{' '}
              {LABELS[option]}
            </label>
          ))}
      </fieldset>
      <p className={styles.itemMeta}>
        Only fjord.json changes. A journal and a site have exactly one vault, and a site's is not
        encrypted: a repository that is not so is refused.
      </p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was changed">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={busy} disabled={choice === current}>
          Change the kind
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
