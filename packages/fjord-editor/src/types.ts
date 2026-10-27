// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The interface of the editors (clients/web/DESIGN.md §10). Everything a client needs to use them is here, and
 * nothing of any client is: the package depends on React and on nothing else at run time.
 */

/**
 * What the person may do. `view` reads; `comment` reads and starts comment threads; `edit` changes the text.
 * (Editing and commenting by people without an account is the app's to allow; the editor only does as it is told.)
 */
export type Role = "view" | "comment" | "edit";

/**
 * Where a comment thread is attached, stored by the app independently of the editor (DESIGN.md §13). A text-quote
 * selector over the Markdown body: the quoted text, some text either side of it, and where it was, so a thread can be
 * found again after the document changed from outside the editor. Offsets count UTF-16 code units of the body as
 * given. The type is tagged so that phase 3 can add a Yjs relative position beside it without a migration.
 */
export type Anchor = TextQuoteAnchor;

export interface TextQuoteAnchor {
  type: "text-quote";
  /** The text the thread is about. */
  quote: string;
  /** Up to `ANCHOR_CONTEXT` characters before it. */
  prefix: string;
  /** Up to `ANCHOR_CONTEXT` characters after it. */
  suffix: string;
  /** Where the quote started in the body when the thread was made: a hint for finding it again, not the truth. */
  position: number;
}

/** A thread, as far as the editor needs to know: what to mark in the text. The thread itself is the app's. */
export interface ThreadMark {
  id: string;
  anchor: Anchor;
  resolved: boolean;
  /** The thread could not be found in the text any more. It is kept by the app, and not marked. */
  outdated: boolean;
}

/**
 * How a document editor and the app talk about comments. The editor marks threads and says when the person asks for
 * one; the thread panel, the replies, the live updates and the storage are the app's (DESIGN.md §13).
 */
export interface CommentsAdapter {
  /** The threads to mark in the text now. */
  threads(): readonly ThreadMark[];
  /** Called when `threads()` has changed (a comment arrived live); returns how to stop. */
  subscribe(listener: () => void): () => void;
  /** The person selected text and asked to comment on it. The app opens its panel for the new thread. */
  create(anchor: Anchor): void;
  /** The person chose a thread's mark in the text. */
  open(threadId: string): void;
  /** The thread the app is showing now, which is marked more strongly. Optional: without it no thread is. */
  active?(): string | null;
}

/** What a client may do to an editor from outside. */
export interface EditorHandle {
  focus(): void;
}

interface CommonProps {
  /** A name for the editing surface, for people who cannot see it. */
  "aria-label"?: string;
  className?: string;
}

export interface DocumentEditorProps extends CommonProps {
  /** The Markdown body, frontmatter removed: the app keeps the header and puts it back (DESIGN.md §9). */
  value: string;
  /**
   * Called with the whole new body after the person edited it. Never called for a change the app made by setting
   * `value`, nor when `role` is not `edit`.
   */
  onChange?: ((body: string) => void) | undefined;
  role: Role;
  comments?: CommentsAdapter | undefined;
  /**
   * For a person with no account: called before their first edit or comment, so the app can ask for a display name
   * (DESIGN.md §12). Resolve `true` once a name is set, `false` if they decline: nothing happens then, and the
   * editor asks again at the next attempt. Never called once it has answered `true`, nor for `view`.
   */
  onNeedName?: (() => Promise<boolean>) | undefined;
}

export interface NoteEditorProps extends CommonProps {
  /** The whole file: a note has no header the editor needs to know about. */
  value: string;
  onChange?: ((text: string) => void) | undefined;
  readOnly?: boolean | undefined;
}
