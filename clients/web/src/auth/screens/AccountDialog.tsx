"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Dialog } from "../../ui";

/** The account as a dialog over the page it was opened from (`app/@modal/(.)account`): closing it goes back to that page, as the browser's back button does. */
export function AccountDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Dialog open onClose={() => router.back()} size="lg" aria-label="Account" title="Account">
      {children}
    </Dialog>
  );
}
