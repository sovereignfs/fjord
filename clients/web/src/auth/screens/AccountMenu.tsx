'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '../client';
import { UserMenu } from '../../ui';
import styles from './AccountMenu.module.css';

/**
 * The menu at the foot of the rail, which opens from the person's avatar: who they are (their name and address, above a rule), *Account*, and *Sign out* last. *Account* is a soft
 * navigation, which is what lets `/account` open as a dialog over the page they are on (`app/@modal/(.)account`); signing out ends the session and goes to the front page.
 */
export function AccountMenu({
  name,
  email,
  avatarUrl,
}: {
  name: string;
  email: string;
  avatarUrl?: string | undefined;
}) {
  const router = useRouter();
  return (
    <div className={styles.menu}>
      <UserMenu
        name={name}
        email={email}
        {...(avatarUrl ? { avatarUrl } : {})}
        aria-label="User menu"
        items={[
          { label: 'Account', icon: 'user', onSelect: () => router.push('/account') },
          {
            label: 'Sign out',
            icon: 'log-out',
            destructive: true,
            onSelect: () => {
              void authClient.signOut().finally(() => window.location.assign('/'));
            },
          },
        ]}
      />
    </div>
  );
}
