"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft, sendDraft, sendVersion } from "../../working/client";
import { DraftSaver, type SaverStatus } from "../../working/saver";
import { MAX_MESSAGE_CHARS } from "../../working/limits";
import { hasConflictMarkers } from "../../working/markers";

/** The draft the page found for this note: its text and the version of the note it was started from. */
export interface DraftOfNote {
  content: string;
  baseBlob: string;
}

/**
 * A note in the note editor, kept as a draft as it is edited (ROADMAP 1b.2, 1b.8). Nothing typed here goes to the
 * repository: the text is sent to the server a moment after the last change (`DraftSaver`), where it waits until
 * **Save version** makes it one commit (1b.9). Closing the page and opening it again finds the draft, and says so.
 *
 * The editor is given the text it starts with and never again: what is on screen is the editor's, and what the saver
 * has is told of each change. Leaving the page sends what is waiting, and a text that could not be kept is not left
 * without a warning.
 */
export function NoteView({ connectionId, path, label, text, blob, draft }: { connectionId: number; path: string; label: string; text: string; blob: string; draft: DraftOfNote | null }) {
  const start = draft?.content ?? text;
  const base = draft?.baseBlob ?? blob;
  const saver = useMemo(() => new DraftSaver({ initial: start, send: (content) => sendDraft(connectionId, path, base, content) }), [connectionId, path, start, base]);
  const [status, setStatus] = useState<SaverStatus>(saver.status);
  // Whether the server holds a draft of this note: it did, or something has been kept since.
  const [hasDraft, setHasDraft] = useState(draft !== null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The page was reloaded to show a version that has just been made: say so, once.
  useEffect(() => {
    try {
      const key = savedKey(connectionId, path);
      const commit = window.sessionStorage.getItem(key);
      if (commit) {
        window.sessionStorage.removeItem(key);
        setSaved(commit);
      }
    } catch {
      // No storage (a private window): the version was made all the same.
    }
  }, [connectionId, path]);

  useEffect(() => {
    const stop = saver.subscribe((next) => {
      setStatus(next);
      if (next.state === "kept") setHasDraft(true);
    });
    const leaving = () => {
      void saver.flush();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    // A text that is waiting is sent as the page goes; one that could not be sent is the only one to ask about.
    const warn = (event: BeforeUnloadEvent) => {
      const trouble = saver.status.state === "retrying" || saver.status.state === "stopped" || saver.status.state === "refused";
      if (trouble && saver.unsaved) event.preventDefault();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", warn);
      stop();
      void saver.flush(); // the person went to another page of the app
    };
  }, [saver]);

  async function discard() {
    setDiscarding(true);
    setDiscardFailed(false);
    saver.dispose();
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setDiscarding(false);
    setDiscardFailed(true);
  }

  async function saveVersion() {
    setSaving(true);
    setVersionError(null);
    // What is on screen is kept first, so the version is what the person sees. If that cannot be done, nothing is made.
    await saver.flush();
    if (saver.unsaved) {
      setVersionError("Your latest changes could not be kept on the server yet, so no version was made. Wait for them to be kept, then try again.");
      setSaving(false);
      return;
    }
    const made = await sendVersion(connectionId, path, message);
    if (!made.ok && (made.code === "upstream_changed" || made.code === "gone")) {
      // The note changed in the repository since the draft was started: the page shows both versions, to choose between.
      saver.dispose();
      window.location.reload();
      return;
    }
    if (!made.ok) {
      setVersionError(made.message);
      setSaving(false);
      return;
    }
    // The draft is gone and the note is the version: the page is read again, with nothing more sent for the old text.
    saver.dispose();
    try {
      window.sessionStorage.setItem(savedKey(connectionId, path), made.commit);
    } catch {
      // Not remembering it only means the page does not say so.
    }
    window.location.reload();
  }

  const unsettled = hasConflictMarkers(saver.text);
  return (
    <div>
      {draft ? (
        <div className={styles.notice}>
          <Alert variant="info" heading="Your changes were kept">
            These are changes you made earlier and have not saved as a version. They are kept on this server, not in the repository.
          </Alert>
        </div>
      ) : null}
      {unsettled ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading="There are conflicts to settle in this text">
            Your changes and the repository&apos;s are both here, between the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> lines. Keep what you want, and delete the marker lines.
          </Alert>
        </div>
      ) : null}
      {saved ? (
        <div className={styles.notice}>
          <Alert variant="success" heading="Version saved">
            Your changes are now in the repository (commit {saved.slice(0, 7)}).
          </Alert>
        </div>
      ) : null}
      <NoteEditor aria-label={label} value={start} onChange={(next) => saver.change(next)} readOnly={saving} />
      <p className={styles.itemMeta} role="status" aria-live="polite" data-testid="draft-status">
        {describe(status, hasDraft)}
      </p>
      {status.state === "refused" || status.state === "stopped" ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Your changes are not being kept">
            {status.message}
          </Alert>
        </div>
      ) : null}
      {hasDraft ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveVersion();
          }}
        >
          <FormField label="Message" hint="What changed, for the repository's history. Leave it empty for “Edit <name>”.">
            {(field) => <Input {...field} name="message" autoComplete="off" maxLength={MAX_MESSAGE_CHARS} value={message} onChange={(e) => setMessage(e.target.value)} disabled={saving} />}
          </FormField>
          {versionError ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="No version was made">
                {versionError}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant={unsettled ? "secondary" : "primary"} loading={saving}>
              {unsettled ? "Save version anyway" : "Save version"}
            </Button>
          </div>
        </form>
      ) : null}
      {hasDraft ? (
        <div>
          {discardFailed ? (
            <div className={styles.notice}>
              <Alert variant="error">Could not discard the changes. Try again.</Alert>
            </div>
          ) : null}
          {confirming ? (
            <p>
              Discard everything you changed in this note?{" "}
              <Button variant="destructive" size="sm" onClick={discard} loading={discarding}>
                Yes, discard
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={discarding}>
                Keep editing
              </Button>
            </p>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              Discard changes
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

const savedKey = (connectionId: number, path: string) => `fjord:version-saved:${connectionId}:${path}`;

function describe(status: SaverStatus, hasDraft: boolean): string {
  switch (status.state) {
    case "idle":
      return hasDraft ? "" : "No changes yet. What you type is kept as a draft.";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Saving…";
    case "kept":
      return "Changes kept as a draft.";
    case "retrying":
      return "Could not keep your changes. Trying again…";
    case "refused":
    case "stopped":
      return "Changes are not being kept.";
  }
}
