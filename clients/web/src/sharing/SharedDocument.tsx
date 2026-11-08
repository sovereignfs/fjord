import type { ReactNode } from 'react';
import styles from './Sharing.module.css';

/**
 * What a shared document is shown on (the owner's request): a sheet of A4 paper on a gray desk, with the document's name and what it is shared as above the paper. `full` is for a page that is nothing else (a
 * link opened by someone with no account); in the signed-in shell it is a desk inside the page.
 */
export function SharedDocument({
  title,
  meta,
  full = false,
  children,
}: {
  title: string;
  meta: ReactNode;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`${styles.desk} ${full ? styles.deskFull : ''}`} data-testid="shared-document">
      <header className={styles.bar}>
        <h1 className={styles.docTitle}>{title}</h1>
        <div className={styles.docMeta}>{meta}</div>
      </header>
      <article className={styles.paper} aria-label={title}>
        {children}
      </article>
    </div>
  );
}
