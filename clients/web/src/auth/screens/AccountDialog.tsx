"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Dialog } from "../../ui";

/** Security as a dialog over the page it was opened from (`app/@modal/(.)security`): closing it goes back to that page, as the browser's back button does. */
export function AccountDialog({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Dialog open onClose={() => router.back()} size="md" aria-label="Security" title="Security">
      <div style={{ padding: "var(--sv-space-5)" }}>{children}</div>
    </Dialog>
  );
}
