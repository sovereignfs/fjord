'use client';

import { useState } from 'react';
import { Alert, Button } from '@sovereignfs/ui';
import styles from '../auth/screens/screens.module.css';
import { PageAddress } from './PageAddress';
import { copyOf, getCopyStatus, publishCopy, unpublishCopy } from './client';

/**
 * "Publish as a page" for a file of an **encrypted** vault (DESIGN.md §12, ROADMAP 3h.2, RFC 0002). The server has no key, so it cannot render the file: this browser, which
 * has the identity, hands over a **plaintext copy** of the version on screen. That is plaintext leaving the vault by the owner's choice, so it is never offered as a
 * default: the panel says exactly what happens, and nothing is sent until the box is ticked. The copy is kept on the server until *Unpublish*; a later version is
 * published again by publishing again.
 */
export function PublishCopyPanel({
  connectionId,
  path,
  name,
  getText,
}: {
  connectionId: number;
  path: string;
  name: string;
  getText: () => string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [published, setPublished] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function load() {
    const status = await getCopyStatus(connectionId, path);
    if (status.ok) {
      setPublished(status.published);
      setUrl(status.url);
    } else setProblem(status.message);
    setLoaded(true);
  }

  async function make() {
    setBusy(true);
    setProblem(null);
    const made = await publishCopy(connectionId, { path, ...copyOf(getText(), name) });
    setBusy(false);
    if (made.ok) {
      setUrl(new URL(made.url, window.location.origin).href);
      setPublished(true);
      setUnderstood(false);
    } else setProblem(made.message);
  }

  async function end() {
    setBusy(true);
    setProblem(null);
    const ended = await unpublishCopy(connectionId, path);
    setBusy(false);
    if (ended.ok) {
      setPublished(false);
      setUrl(null);
    } else setProblem(ended.message);
  }

  return (
    <details
      className={styles.itemMeta}
      data-testid="publish-copy-panel"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && !loaded) void load();
      }}
    >
      <summary>Publish as a page</summary>
      {problem ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Publishing">
            {problem}
          </Alert>
        </div>
      ) : null}
      {url ? (
        <div className={styles.notice}>
          <Alert variant="success" heading="Published">
            Anyone with this address can read the copy.
            <PageAddress url={url} />
          </Alert>
        </div>
      ) : null}
      {published ? (
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => void end()}
          >
            Unpublish and delete the copy
          </Button>
        </div>
      ) : null}
      <div className={styles.notice}>
        <Alert variant="warning" heading="This puts a readable copy outside the encryption">
          This file is encrypted. To publish it, this browser sends the server a{' '}
          <strong>plaintext copy</strong> of what is on screen now. Anyone with the page&apos;s
          address can read it, and the server keeps the copy until you unpublish. The encrypted file
          in the repository is not changed, and nothing sent stays secret. A later version is
          published by publishing again.
        </Alert>
      </div>
      <label style={{ display: 'block' }}>
        <input
          type="checkbox"
          checked={understood}
          disabled={busy}
          onChange={(event) => setUnderstood(event.target.checked)}
        />{' '}
        I understand, and I want a readable copy of this file published
      </label>
      <div className={styles.actions}>
        <Button type="button" loading={busy} disabled={!understood} onClick={() => void make()}>
          {published ? 'Publish this version' : 'Publish a copy'}
        </Button>
      </div>
    </details>
  );
}
