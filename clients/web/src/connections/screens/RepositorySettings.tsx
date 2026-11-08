'use client';

import { type ReactNode, useState } from 'react';
import { Dialog } from '@sovereignfs/ui';
import { SetIcon } from '../../ui/icons';
import styles from './RepositoryHeader.module.css';

/**
 * The repository's settings (the owner's request after workstream 0003): a button at the end of its name that opens a dialog over the page, in the way the rail's `+` opens the one that
 * connects a repository. What is in it is the server's to say (`children`: its kind, whether it is the default, the way to the list of repositories), so the dialog is only the frame.
 */
export function RepositorySettings({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.iconButton}
        title="Repository settings"
        aria-label="Repository settings"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <SetIcon name="settings-2" size={20} />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        aria-label="Repository settings"
        title="Repository settings"
      >
        <div className={styles.settings}>
          <h1 className={styles.settingsTitle}>Repository settings</h1>
          {children}
        </div>
      </Dialog>
    </>
  );
}
