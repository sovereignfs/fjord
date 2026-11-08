'use client';

import { useState } from 'react';
import { Button } from '../ui';
import styles from '../sharing/Sharing.module.css';

/**
 * A published page's address, and a button that copies it. The address is long and has no place to break, so it wraps wherever it must: it is never wider than what it is in (a dialog). `testId` is for the tests, which read it.
 */
export function PageAddress({ url, testId = 'page-address' }: { url: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className={styles.addressRow}>
      <code className={styles.url} data-testid={testId}>
        {url}
      </code>
      <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
