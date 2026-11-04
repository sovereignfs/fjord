"use client";

import { type ReactNode, useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "./index";

interface Asked {
  /** The question, said in full: what will happen, and what cannot be undone. */
  message: string;
  /** What the button that goes ahead says. */
  confirm: string;
}

/**
 * Asks before something that cannot be undone, in the page. The browser's own `confirm` looks like another program and cannot be styled, and a page in a frame may not be allowed one at all.
 * `const [ask, asking] = useConfirm()`: draw `asking`, and `if (!(await ask({ message, confirm }))) return;`. Closing it (Esc, the backdrop, *Cancel*) is no.
 */
export function useConfirm(): [(asked: Asked) => Promise<boolean>, ReactNode] {
  const [asked, setAsked] = useState<Asked | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);

  const ask = useCallback(
    (next: Asked) =>
      new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsked(next);
      }),
    [],
  );
  const settle = (yes: boolean) => {
    answer.current?.(yes);
    answer.current = null;
    setAsked(null);
  };

  return [ask, <ConfirmDialog key="confirm" open={asked !== null} onClose={() => settle(false)} title="Please confirm" message={asked?.message ?? ""} confirmLabel={asked?.confirm ?? "Yes"} destructive onConfirm={() => settle(true)} />];
}
