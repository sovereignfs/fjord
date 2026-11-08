'use client';

import { type FormEvent, useEffect, useState } from 'react';
import type { JournalEntrySummary } from '../../format/types';
import { keyStore } from '../../keys/client';
import { type Shown, openCiphertext } from '../../keys/files';
import { loadModule } from '../../keys/module';
import { Alert, Button, FormField, Input } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';
import { ciphertextFetcher, readEncryptedEntries } from '../encrypted-timeline';
import { type Timeline, type TimelineEntry, arrange } from '../timeline';
import { TimelineView } from './TimelineView';
import { TagFilter } from './TagFilter';

/**
 * An encrypted journal's timeline (ROADMAP 3b.2, 3b.3), built here from the entries this browser decrypts with its key, and kept in memory
 * only: no entry's date, title or tag is sent to the server or stored. It asks for the key's passphrase when the key is locked.
 */
export function EncryptedTimeline({
  connectionId,
  repo,
  files,
}: {
  connectionId: number;
  /** What the repository is called in an address. */ repo: string;
  /** The vault's encrypted files, by repository path. */ files: { path: string }[];
}) {
  const [state, setState] = useState<
    'checking' | 'none' | 'locked' | 'reading' | 'ready' | 'failed'
  >('checking');
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState(0);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [page, setPage] = useState(1);
  const [tags, setTags] = useState<string[]>([]);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function read() {
    setState('reading');
    try {
      const module = await loadModule();
      const store = keyStore();
      const found = await readEncryptedEntries(
        {
          fetchCiphertext: ciphertextFetcher(connectionId),
          open: (ciphertext) => {
            const shown: Shown = openCiphertext(module, store, ciphertext, 'id', 'entry.md');
            return shown.kind === 'text' ? { name: shown.name, text: shown.text } : undefined;
          },
          summarise: (text, name) =>
            JSON.parse(module.journalEntry(text, name)) as JournalEntrySummary,
        },
        files,
        setProgress,
      );
      setEntries(found.entries);
      setUnreadable(found.unreadable);
      setState('ready');
    } catch {
      setState('failed');
    }
  }

  useEffect(() => {
    void keyStore()
      .status()
      .then((status) => {
        if (status.state === 'none') setState('none');
        else if (status.state === 'locked') setState('locked');
        else void read();
      })
      .catch(() => setState('failed'));
    // Read once, when the page opens, so the dependencies are empty on purpose.
  }, []);

  useEffect(() => {
    if (state !== 'ready') return;
    void loadModule().then((module) =>
      setTimeline(arrange(module, entries, { page, filter: { tags, ...range } })),
    );
  }, [state, entries, page, tags, range]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    try {
      await keyStore().unlock(passphrase);
      setPassphrase('');
      await read();
    } catch {
      setProblem('That passphrase does not open your key.');
    }
  }

  if (state === 'none') {
    return (
      <Alert variant="info" heading="Your key is not in this browser">
        This journal is encrypted, and its timeline is read here with your key.{' '}
        <a href="/account?section=security&tab=keys">Make or import your key</a>.
      </Alert>
    );
  }
  if (state === 'locked') {
    return (
      <form className={styles.form} onSubmit={unlock} aria-label="Unlock your key">
        <p>
          This journal is encrypted. Its timeline is read here, with your key, and nothing of it is
          sent to the server.
        </p>
        <FormField label="Your key's passphrase" error={problem ?? undefined}>
          {(field) => (
            <Input
              {...field}
              type="password"
              name="passphrase"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          )}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit">Unlock and read</Button>
        </div>
      </form>
    );
  }
  if (state === 'failed')
    return (
      <Alert variant="error">
        The journal's entries could not be read just now. Try again in a moment.
      </Alert>
    );
  if (state !== 'ready' || timeline === null)
    return (
      <p className={styles.itemMeta} role="status">
        Reading entries… {progress} of {files.length}
      </p>
    );
  return (
    <>
      <TagFilter
        tags={timeline.tags}
        chosen={tags}
        range={range}
        onChange={(next, nextRange) => {
          setTags(next);
          setRange(nextRange);
          setPage(1);
        }}
      />
      {unreadable > 0 ? (
        <p className={styles.itemMeta}>
          {unreadable} {unreadable === 1 ? 'entry' : 'entries'} could not be opened with this key.
        </p>
      ) : null}
      <TimelineView connectionId={connectionId} repo={repo} timeline={timeline} />
      {timeline.pages > 1 ? (
        <p className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={timeline.page <= 1}
            onClick={() => setPage(timeline.page - 1)}
          >
            Newer
          </Button>
          <span className={styles.itemMeta}>
            {' '}
            Page {timeline.page} of {timeline.pages}{' '}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={timeline.page >= timeline.pages}
            onClick={() => setPage(timeline.page + 1)}
          >
            Older
          </Button>
        </p>
      ) : null}
    </>
  );
}
