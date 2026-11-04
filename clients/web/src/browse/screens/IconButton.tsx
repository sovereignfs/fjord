"use client";

import type { ReactNode } from "react";
import styles from "./FileActions.module.css";

/**
 * A button that is only an icon (the owner's request for a document's actions): its name is for a screen reader and for a tooltip, and what it does is a dialog's (`ActionDialog`) or a confirmation's.
 * `danger` is the colour of what takes something away.
 */
export function IconButton({ label, children, onClick, disabled = false, danger = false, haspopup = true, title }: { label: string; children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; haspopup?: boolean; title?: string | undefined }) {
  return (
    <button type="button" className={`${styles.iconButton} ${danger ? styles.danger : ""}`} title={title ?? label} aria-label={label} aria-haspopup={haspopup ? "dialog" : undefined} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
