"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { type MutableRefObject, useEffect, useMemo, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft, sendDraft, sendVersion } from "../../working/client";
import { MAX_MESSAGE_CHARS } from "../../working/limits";
import { DraftSaver, type SaverStatus } from "../../working/saver";
import { keyStore } from "../client";
import { type Naming, sealText, toBase64 } from "../files";
import { loadModule } from "../module";

/**
 * An encrypted file being edited in the browser (ROADMAP 2b.3, DESIGN.md §11). What is typed is **encrypted here, to the vault's recipients, before each send**:
 * the draft the server keeps is ciphertext (`encrypted: true`), so the server holds no plaintext of it at any time, and a version is those bytes committed as
 * they are. Sealing needs only the recipients' public keys, so it works the moment the identity locks, which is why leaving the page can still send what is waiting.
 * Typing counts as use of the identity, so working on a file does not lock it.
 */
export function EncryptedEditor({
  connectionId,
  path,
  name,
  naming,
  recipients,
  text,
  base,
  hasDraft: hadDraft,
  readOnly,
  flushRef,
}: {
  connectionId: number;
  path: string;
  /** The file's real name, for the container of an `id`-named vault. */
  name: string;
  naming: Naming;
  /** The text of the vault's recipients file. */
  recipients: string;
  /** What the editor starts with: the draft decrypted, else the file. */
  text: string;
  /** The version of the file the draft is of. */
  base: string;
  hasDraft: boolean;
  /** Shown to be read, not changed (the file changed in the repository and a choice is waiting). */
  readOnly: boolean;
  /** Set to send what is waiting: the page awaits it before it hides the text or re-reads the draft, so that what it then opens is what was typed. */
  flushRef: MutableRefObject<(() => Promise<void>) | null>;
}) {
  const saver = useMemo(
    () =>
      new DraftSaver({
        initial: text,
        send: async (content) => {
          try {
            const sealed = sealText(await loadModule(), { text: content, name, naming, recipients });
            return await sendDraft(connectionId, path, base, toBase64(sealed), true);
          } catch {
            return { kind: "refused", stop: false, message: "This text could not be encrypted, so it was not kept. Nothing was sent." };
          }
        },
      }),
    [connectionId, path, name, naming, recipients, text, base],
  );
  const [status, setStatus] = useState<SaverStatus>(saver.status);
  const [hasDraft, setHasDraft] = useState(hadDraft);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);

  useEffect(() => {
    const stop = saver.subscribe((next) => {
      setStatus(next);
      if (next.state === "kept") setHasDraft(true);
    });
    const leaving = () => void saver.flush();
    const hidden = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    const warn = (event: BeforeUnloadEvent) => {
      const trouble = saver.status.state === "retrying" || saver.status.state === "stopped" || saver.status.state === "refused";
      if (trouble && saver.unsaved) event.preventDefault();
    };
    flushRef.current = () => saver.flush();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", warn);
      stop();
      flushRef.current = null;
      void saver.flush(); // hidden, locked or left: what is waiting is sealed and sent first
    };
  }, [saver, flushRef]);

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
    await saver.flush();
    if (saver.unsaved) {
      setVersionError("Your latest changes could not be kept on the server yet, so no version was made. Wait for them to be kept, then try again.");
      setSaving(false);
      return;
    }
    const made = await sendVersion(connectionId, path, message);
    if (!made.ok && (made.code === "upstream_changed" || made.code === "gone")) {
      saver.dispose();
      window.location.reload();
      return;
    }
    if (!made.ok) {
      setVersionError(made.message);
      setSaving(false);
      return;
    }
    saver.dispose();
    try {
      window.sessionStorage.setItem(savedKey(connectionId, path), made.commit);
    } catch {
      // Not remembering it only means the page does not say so.
    }
    window.location.reload();
  }

  return (
    <div data-testid="encrypted-editor">
      <NoteEditor
        aria-label={name}
        value={text}
        readOnly={readOnly || saving}
        onChange={(next) => {
          keyStore().touch();
          saver.change(next);
        }}
      />
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
      {hasDraft && !readOnly ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void saveVersion();
          }}
        >
          <FormField label="Message" hint="What changed, for the repository's history; it is not encrypted. Leave it empty for “Edit <name>”.">
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
            <Button type="submit" loading={saving}>
              Save version
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
              Discard everything you changed in this file?{" "}
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

export const savedKey = (connectionId: number, path: string) => `fjord:version-saved:${connectionId}:${path}`;

function describe(status: SaverStatus, hasDraft: boolean): string {
  switch (status.state) {
    case "idle":
      return hasDraft ? "" : "No changes yet. What you type is encrypted here and kept as a draft.";
    case "pending":
      return "Unsaved changes…";
    case "saving":
      return "Encrypting and saving…";
    case "kept":
      return "Changes kept as an encrypted draft.";
    case "retrying":
      return "Could not keep your changes. Trying again…";
    case "refused":
    case "stopped":
      return "Changes are not being kept.";
  }
}
