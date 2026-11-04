// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a person chose for a document the visual editor would restyle or could not hold exactly (the two buttons of the notice): to **reformat** it and edit it visually, or to edit it as
 * **Markdown**, unchanged. It is the person's, about one document, and is kept in this browser (`localStorage`) under the app's key for the document, so that the question is not asked at
 * every opening of it: before this the choice lived only in the page, and the notice came back whenever the page was opened again. Storage that is refused or full is no choice kept
 * (the question is asked again), never an error.
 */
export type Choice = "reformat" | "markdown";

const PREFIX = "fjord-editor:choice:";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readChoice(key: string, store: Pick<Storage, "getItem"> | undefined = storage()): Choice | null {
  try {
    const kept = store?.getItem(PREFIX + key);
    return kept === "reformat" || kept === "markdown" ? kept : null;
  } catch {
    return null;
  }
}

export function rememberChoice(key: string, choice: Choice, store: Pick<Storage, "setItem"> | undefined = storage()): void {
  try {
    store?.setItem(PREFIX + key, choice);
  } catch {
    // Not kept: it is asked again next time.
  }
}

export function forgetChoice(key: string, store: Pick<Storage, "removeItem"> | undefined = storage()): void {
  try {
    store?.removeItem(PREFIX + key);
  } catch {
    // Nothing was kept that could be taken away.
  }
}
