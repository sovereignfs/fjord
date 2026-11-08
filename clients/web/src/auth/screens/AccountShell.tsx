'use client';

import { type ReactNode, useState } from 'react';
import { Icon, type IconName } from '../../ui';
import styles from './AccountShell.module.css';

import type { AccountSection } from './account-query';

const SECTIONS: { id: AccountSection; label: string; icon: IconName }[] = [
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'preferences', label: 'Preferences', icon: 'sliders-horizontal' },
];

/**
 * The account, in the way the legacy Sovereign's account dialog is made (the owner's request): its sections down the left, the open one on the right. Each is rendered by the server and
 * handed in, so choosing one is only showing it; the ones that are not shown stay mounted, so a half-typed passphrase or password is not lost by looking at another. The same is shown as
 * a dialog over the page it was opened from, and as a page at `/account`.
 */
export function AccountShell({
  initial,
  profile,
  security,
  preferences,
}: {
  initial: AccountSection;
  profile: ReactNode;
  security: ReactNode;
  preferences: ReactNode;
}) {
  const [section, setSection] = useState<AccountSection>(initial);
  const panels: Record<AccountSection, ReactNode> = { profile, security, preferences };
  return (
    <div className={styles.shell}>
      <div className={styles.side}>
        <h1>Account</h1>
        <nav className={styles.nav} aria-label="Account sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={section === entry.id ? 'page' : undefined}
              onClick={() => setSection(entry.id)}
            >
              <Icon name={entry.icon} aria-hidden />
              {entry.label}
            </button>
          ))}
        </nav>
      </div>
      {SECTIONS.map((entry) => (
        <section
          key={entry.id}
          className={styles.panel}
          aria-label={entry.label}
          hidden={section !== entry.id}
        >
          {panels[entry.id]}
        </section>
      ))}
    </div>
  );
}
