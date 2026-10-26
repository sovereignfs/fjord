// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { useCallback, useRef } from "react";

/**
 * Asks the app for a person's display name before their first edit or comment, and only as long as it has not been
 * given (`DocumentEditorProps.onNeedName`). Several attempts while the app is still asking share one question. A
 * question that fails is an answer of no.
 */
export function useNameGate(onNeedName: (() => Promise<boolean>) | undefined): () => Promise<boolean> {
  const named = useRef(false);
  const asking = useRef<Promise<boolean> | null>(null);
  const latest = useRef(onNeedName);
  latest.current = onNeedName;

  return useCallback(async () => {
    const ask = latest.current;
    if (!ask || named.current) return true;
    asking.current ??= ask()
      .catch(() => false)
      .then((answer) => {
        named.current = answer;
        return answer;
      })
      .finally(() => {
        asking.current = null;
      });
    return asking.current;
  }, []);
}
