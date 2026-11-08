'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '@sovereignfs/ui';
import styles from '../../auth/screens/screens.module.css';
import type { PreviewView } from '../preview';
import { describe, PreviewRows } from './PreviewRows';

interface Listing {
  previews: PreviewView[];
  pending: { files: string[]; skipped: { path: string; reason: string }[] };
  max: number;
}

const POLL_MS = 5000;

/**
 * Previewing a site's unsaved changes through its host (ROADMAP 3d.1): "Preview" puts the drafts on a branch of their own, which the host builds like
 * any branch, and the page shows the address the host gives for it. The branch is the preview's life: it stays until "Stop previewing" deletes it. The
 * default branch is never written, and the site as it is does not change.
 */
export function PreviewPanel({ connectionId }: { connectionId: number }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/connections/${connectionId}/previews`, {
        credentials: 'same-origin',
      });
      const body = (await response.json().catch(() => null)) as
        (Listing & { error?: { message?: string } }) | null;
      if (!response.ok) {
        // A repository that is not a site, or cannot be read just now, has no previews to show: the page is not the worse for it.
        setListing(null);
        return;
      }
      setListing(body as Listing);
    } catch {
      // The next look tries again.
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a preview is waiting for its host or being built, look again; once all are settled, stop.
  const active = listing?.previews.some((preview) => describe(preview.outcome).busy) ?? false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/previews`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok)
        setError(
          body?.error?.message ?? 'The preview was not started. Nothing was changed. Try again.',
        );
    } catch {
      setError('Could not reach this server. Nothing was changed. Try again.');
    }
    setBusy(false);
    await load();
  }

  async function stop(branch: string) {
    setStopping(branch);
    setError(null);
    try {
      const response = await fetch(
        `/api/connections/${connectionId}/previews?branch=${encodeURIComponent(branch)}`,
        { method: 'DELETE', credentials: 'same-origin' },
      );
      if (!response.ok && response.status !== 404)
        setError('The preview was not stopped. Try again.');
    } catch {
      setError('Could not reach this server. The preview was not stopped.');
    }
    setStopping(null);
    await load();
  }

  if (listing === null) return null;
  const changes = listing.pending.files.length;
  return (
    <section aria-label="Preview" data-testid="preview-panel">
      <h3>Preview</h3>
      <p className={styles.itemMeta}>
        {changes > 0
          ? `You have ${changes === 1 ? 'an unsaved change' : `${changes} unsaved changes`} to this site's posts. Preview puts ${changes === 1 ? 'it' : 'them'} on a branch of its own for your host to build; the site as it is does not change.`
          : 'Edit a post and it is kept as you type. Then preview it here, on a branch of its own that your host builds, before you save a version.'}
      </p>
      {listing.pending.skipped.length > 0 ? (
        <p className={styles.itemMeta}>
          Left out: {listing.pending.skipped.map((entry) => entry.path).join(', ')}, which changed
          in the repository after you began editing.
        </p>
      ) : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was changed">
            {error}
          </Alert>
        </div>
      ) : null}
      <PreviewRows
        previews={listing.previews}
        onStop={(branch) => void stop(branch)}
        stopping={stopping}
      />
      <p>
        <Button
          variant="secondary"
          loading={busy}
          disabled={changes === 0 || listing.previews.length >= listing.max}
          onClick={() => void start()}
        >
          Preview
        </Button>
        {listing.previews.length >= listing.max ? (
          <span className={styles.itemMeta}>
            {' '}
            You have {listing.max} previews; stop one to start another.
          </span>
        ) : null}
      </p>
    </section>
  );
}
