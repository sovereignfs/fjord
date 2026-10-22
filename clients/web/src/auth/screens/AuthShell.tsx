import type { ReactNode } from "react";
import { Card } from "../../ui";
import styles from "./screens.module.css";

/** The frame of a sign-in screen: the product's name, a card, a heading and what it is for. */
export function AuthShell({ title, lead, children, footer }: { title: string; lead?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className={styles.page}>
      <a className={styles.brand} href="/">
        Fjord
      </a>
      <Card as="article" padding="lg" className={styles.card}>
        <h1 className={styles.title}>{title}</h1>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
        {children}
      </Card>
      {footer ? <p className={styles.footer}>{footer}</p> : null}
    </main>
  );
}
