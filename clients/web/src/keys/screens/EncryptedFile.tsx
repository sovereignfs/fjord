"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { keyStore, onAutoLock } from "../client";
import { type Naming, type Shown, fromBase64, openCiphertext } from "../files";
import { loadModule } from "../module";
import { KeyError, type Status } from "../store";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { discardDraft, sendResolve } from "../../working/client";
import { EncryptedEditor, savedKey } from "./EncryptedEditor";

/**
 * An encrypted file, opened in the browser (ROADMAP 2b.2, DESIGN.md §2) and edited there (2b.3). The server hands over the stored bytes (`/api/connections/<id>/ciphertext`)
 * and has no key; they are decrypted here with the identity kept in this browser (`src/keys/`), unpacked from their container in an `id`-named vault, and shown in the
 * note editor. If there is a draft of the file, it is the draft's ciphertext that is opened, and what is typed is encrypted here before it is sent (`EncryptedEditor`).
 * Nothing decrypted is sent anywhere, written to storage, or kept once the page is left or the file is hidden: the bytes are wiped as soon as they are text (the text
 * itself is a string, which a page cannot wipe, and is the reason to hide it when done).
 */

/** What the page found of this file's draft on the server: ciphertext, and the version of the file it is of. */
export interface EncryptedDraft {
  content: string;
  baseBlob: string;
}

async function open(connectionId: number, path: string, naming: Naming, logical: string, draft: EncryptedDraft | null): Promise<Shown> {
  let ciphertext: Uint8Array;
  if (draft) {
    ciphertext = fromBase64(draft.content);
  } else {
    const response = await fetch(`/api/connections/${connectionId}/ciphertext?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      throw new KeyError("unreadable", body?.error?.message ?? "The file could not be fetched just now.");
    }
    ciphertext = new Uint8Array(await response.arrayBuffer());
  }
  return openCiphertext(await loadModule(), keyStore(), ciphertext, naming, logical);
}

export function EncryptedFile({
  connectionId,
  path,
  naming,
  logical,
  blob,
  draft,
  recipients,
}: {
  connectionId: number;
  path: string;
  naming: Naming;
  logical: string;
  /** The file's blob in the repository now; not known for a repository too large to list, and then it is not edited. */
  blob: string | undefined;
  draft: EncryptedDraft | null;
  /** The text of the vault's recipients file, or why there is none (then it is not edited). */
  recipients: { ok: true; text: string } | { ok: false; message: string };
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const asked = useRef(false);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const router = useRouter();
  // The repository's file is another version than the one the draft is of: nothing is edited until the person chooses (ROADMAP 1b.10).
  const upstreamChanged = draft !== null && blob !== undefined && draft.baseBlob !== blob;
  const base = draft?.baseBlob ?? blob;

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

  const refresh = useCallback(async () => {
    try {
      setStatus(await keyStore().status());
    } catch {
      setError("This browser would not open its key storage, so nothing can be decrypted here.");
    }
  }, []);

  const show = useCallback(async () => {
    setError(null);
    setWorking("Opening the file…");
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      setShown(await open(connectionId, path, naming, logical, draft));
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : "The file could not be opened.");
    } finally {
      setWorking(null);
    }
  }, [connectionId, path, naming, logical, draft]);

  useEffect(() => {
    void refresh();
    return onAutoLock(() => {
      // Locked by itself after a quiet period: what was typed is sent first, then what was decrypted goes, and the draft is read again for the next opening.
      void (async () => {
        await flushRef.current?.().catch(() => undefined);
        setShown(null);
        asked.current = false;
        router.refresh();
        await refresh();
      })();
    });
  }, [refresh, router]);

  // Already unlocked in this page: open at once, once.
  useEffect(() => {
    if (status?.state === "unlocked" && !shown && !asked.current) {
      asked.current = true;
      void show();
    }
  }, [status, shown, show]);

  async function onUnlock(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setWorking("Unlocking…");
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await keyStore().unlock(passphrase);
      setPassphrase("");
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : "The identity could not be unlocked.");
    } finally {
      setWorking(null);
      await refresh();
    }
  }

  const hide = async () => {
    await flushRef.current?.().catch(() => undefined);
    setShown(null);
    asked.current = true; // hidden on purpose: not opened again until asked
    router.refresh(); // so that opening it again shows what was typed
  };

  return (
    <div data-testid="encrypted-file">
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {working ? (
        <div className={styles.notice} role="status">
          <Alert variant="info">{working}</Alert>
        </div>
      ) : null}

      {status === null ? <p>Looking…</p> : null}
      {status?.state === "none" ? (
        <Alert variant="info" heading="No identity in this browser">
          This file is encrypted. To read it, make or bring the age identity it was encrypted to, on the <a href="/account/keys">Keys page</a>. It stays in this browser; the server never has it.
        </Alert>
      ) : null}
      {status?.state === "locked" && !shown ? (
        <form className={styles.form} onSubmit={onUnlock} style={{ marginTop: 0 }}>
          <p className={styles.itemMeta}>This file is encrypted. Unlock your identity to read it; the passphrase is not sent anywhere.</p>
          <FormField label="Passphrase" required>
            {(field) => <Input {...field} type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={working !== null} />}
          </FormField>
          <div className={styles.actions}>
            <Button type="submit" loading={working !== null}>
              Unlock and open
            </Button>
          </div>
        </form>
      ) : null}
      {status?.state === "unlocked" && !shown && !working && asked.current ? (
        <div className={styles.actions}>
          <Button type="button" onClick={() => void show()}>
            Open
          </Button>
        </div>
      ) : null}

      {saved ? (
        <div className={styles.notice}>
          <Alert variant="success" heading="Version saved">
            Your changes are now in the repository, encrypted (commit {saved.slice(0, 7)}).
          </Alert>
        </div>
      ) : null}
      {draft && !shown && !error ? (
        <p className={styles.itemMeta}>Changes you made earlier are kept on this server as an encrypted draft. Unlock your identity to see and continue them.</p>
      ) : null}

      {shown?.kind === "text" ? (
        <>
          {upstreamChanged && blob ? <UpstreamChanged connectionId={connectionId} path={path} upstreamBlob={blob} /> : null}
          <p className={styles.itemMeta}>
            Decrypted in this browser: {shown.name}.{" "}
            {base !== undefined && recipients.ok && !upstreamChanged
              ? "What you type is encrypted here, to this vault's recipients, before it is sent; the server never has the text."
              : "It is read-only here, and nothing of it leaves this page."}
          </p>
          {status?.state === "unlocked" && recipients.ok && !recipients.text.includes(status.recipient) ? (
            <div className={styles.notice}>
              <Alert variant="warning" heading="Your key is not among this vault's recipients">
                It opened this file, but a file saved now would be encrypted to the recipients in the vault&apos;s recipients file, which does not list your key: you could not open it afterwards.
              </Alert>
            </div>
          ) : null}
          {!recipients.ok ? (
            <div className={styles.notice}>
              <Alert variant="info" heading="Not editable here">
                {recipients.message}
              </Alert>
            </div>
          ) : null}
          {base !== undefined && recipients.ok ? (
            <EncryptedEditor connectionId={connectionId} path={path} name={shown.name} naming={naming} recipients={recipients.text} text={shown.text} base={base} hasDraft={draft !== null} readOnly={upstreamChanged} flushRef={flushRef} />
          ) : (
            <EncryptedReader name={shown.name} text={shown.text} />
          )}
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={() => void hide()}>
              Hide
            </Button>
          </div>
        </>
      ) : null}
      {shown?.kind === "binary" ? (
        <>
          <Alert variant="info" heading="Not text">
            {shown.name} opened, and is {shown.bytes} bytes of something that is not text, which this page does not show.
          </Alert>
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={() => void hide()}>
              Hide
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function EncryptedReader({ name, text }: { name: string; text: string }) {
  return <NoteEditor aria-label={name} value={text} readOnly />;
}

/**
 * The file changed in the repository after the draft was started (ROADMAP 1b.10). The server has no key, so it cannot combine the two: the person keeps theirs
 * (the draft is moved onto the file as it is, still encrypted, and the next version is a commit on top of what is there, which stays in the history) or takes
 * the repository's (the draft is thrown away).
 */
function UpstreamChanged({ connectionId, path, upstreamBlob }: { connectionId: number; path: string; upstreamBlob: string }) {
  const [busy, setBusy] = useState<"mine" | "theirs" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mine() {
    setBusy("mine");
    setError(null);
    const done = await sendResolve(connectionId, path, "mine", upstreamBlob);
    if (done.ok || done.lookAgain) {
      window.location.reload();
      return;
    }
    setError(done.message);
    setBusy(null);
  }

  async function theirs() {
    setBusy("theirs");
    setError(null);
    if (await discardDraft(connectionId, path)) {
      window.location.reload();
      return;
    }
    setError("Could not discard the changes. Try again.");
    setBusy(null);
  }

  return (
    <div className={styles.notice}>
      <Alert variant="warning" heading="This file changed in the repository after you started">
        Someone saved a newer version from somewhere else. What you see below is your draft. The server cannot combine the two, as it has no key to read either: keep yours, which becomes the next version and leaves theirs in the history, or take theirs and drop your changes.
      </Alert>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className={styles.actions}>
        <Button type="button" onClick={() => void mine()} loading={busy === "mine"} disabled={busy !== null}>
          Keep mine
        </Button>{" "}
        <Button type="button" variant="secondary" onClick={() => void theirs()} loading={busy === "theirs"} disabled={busy !== null}>
          Take theirs
        </Button>
      </div>
    </div>
  );
}
