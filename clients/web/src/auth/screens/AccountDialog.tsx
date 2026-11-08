'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Dialog } from '../../ui';

/** The account as a dialog over the page it was opened from (`app/@modal/(.)account`): closing it goes back to that page, as the browser's back button does. `fixed` is the design system's capped box (64rem by 44rem, and the whole screen on a phone): `lg` fills the viewport, which is too wide for what is in it. */
export function AccountDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Dialog open onClose={() => router.back()} size="fixed" aria-label="Account" title="Account">
      {children}
    </Dialog>
  );
}
