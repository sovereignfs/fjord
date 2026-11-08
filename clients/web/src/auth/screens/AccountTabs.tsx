'use client';

import { type ReactNode, useState } from 'react';
import { Tabs } from '@sovereignfs/ui';

/**
 * Security's two parts under one set of tabs: the security of the sign-in (*General*, the first, and what opens), and the key kept in this browser (*Encryption identity*). Both are rendered by the server and handed in, so
 * switching tabs is only showing one of them; the one that is not shown is kept mounted, so a half-typed passphrase is not lost by looking at the other. With
 * no security part (an instance that signs in only through Sovereign has none) there is one panel and no tabs.
 */
export function AccountTabs({
  initial,
  keys,
  security,
}: {
  initial: 'general' | 'keys';
  keys: ReactNode;
  security: ReactNode | null;
}) {
  const [tab, setTab] = useState<'general' | 'keys'>(security === null ? 'keys' : initial);
  if (security === null) return <>{keys}</>;
  return (
    <div>
      <Tabs
        aria-label="Security"
        value={tab}
        onChange={(value) => setTab(value === 'keys' ? 'keys' : 'general')}
        items={[
          { value: 'general', label: 'General' },
          { value: 'keys', label: 'Encryption identity' },
        ]}
      />
      <div hidden={tab !== 'general'} style={{ paddingTop: 'var(--sv-space-5)' }}>
        {security}
      </div>
      <div hidden={tab !== 'keys'} style={{ paddingTop: 'var(--sv-space-5)' }}>
        {keys}
      </div>
    </div>
  );
}
