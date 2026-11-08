'use client';

import type { ReactNode } from 'react';
import { Dialog } from '../../ui';
import styles from './ActionDialog.module.css';

/**
 * What an action that asks for something opens (the owner's request after the first listings): a dialog over the page, with the action's name for its heading, and the form in it. The buttons that
 * open them are the listing's actions (`Listing`); a form is never drawn in the page among the files. Closing it (Esc, the scrim, *Cancel*) is the form's own, so a form that is half
 * filled in is kept as long as the page is.
 */
export function ActionDialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="md" aria-label={title} title={title}>
      <div className={styles.body}>
        <h2 className={styles.heading}>{title}</h2>
        {children}
      </div>
    </Dialog>
  );
}
