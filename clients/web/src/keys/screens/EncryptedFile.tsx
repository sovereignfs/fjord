"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { keyStore, onAutoLock } from "../client";
import { loadModule } from "../module";
import { KeyError, type Status } from "../store";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/**
 * An encrypted file, opened in the browser (ROADMAP 2b.2, DESIGN.md §2). The server hands over the stored bytes (`/api/connections/<id>/ciphertext`) and has no
 * key; they are decrypted here with the identity kept in this browser (`src/keys/`), unpacked from their container in an `id`-named vault, and shown read-only in
 * the note editor. Nothing decrypted is sent anywhere, written to storage, or kept once the page is left or the file is hidden: the bytes are wiped as soon as
 * they are text (the text itself is a string, which a page cannot wipe, and is the reason to hide it when done).
 */
type Shown = { kind: "text"; name: string; text: string } | { kind: "binary"; name: string; bytes: number };

const decoder = new TextDecoder("utf-8", { fatal: true });

async function open(connectionId: number, path: string, naming: "plain" | "id", logical: string): Promise<Shown> {
  const response = await fetch(`/api/connections/${connectionId}/ciphertext?path=${encodeURIComponent(path)}`, { credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    throw new KeyError("unreadable", body?.error?.message ?? "The file could not be fetched just now.");
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  const module = await loadModule();
  let plain: Uint8Array;
  try {
    plain = keyStore().with((secret) => module.decrypt(ciphertext, secret));
  } catch (error) {
    if (error instanceof KeyError) throw error;
    throw new KeyError("unreadable", "This identity cannot open the file: it is not one of the keys it was encrypted to, or the file is damaged.");
  }
  let name = logical.slice(logical.lastIndexOf("/") + 1);
  let contents = plain;
  if (naming === "id") {
    try {
      const unwrapped = module.unwrapContainer(plain);
      name = unwrapped.name;
      contents = unwrapped.contents;
    } catch {
      plain.fill(0);
      throw new KeyError("unreadable", "The file opened, but what is inside it is not the container the format asks for.");
    } finally {
      plain.fill(0);
    }
  }
  try {
    return { kind: "text", name, text: decoder.decode(contents) };
  } catch {
    return { kind: "binary", name, bytes: contents.byteLength };
  } finally {
    contents.fill(0);
  }
}

export function EncryptedFile({ connectionId, path, naming, logical }: { connectionId: number; path: string; naming: "plain" | "id"; logical: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const asked = useRef(false);

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
      setShown(await open(connectionId, path, naming, logical));
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : "The file could not be opened.");
    } finally {
      setWorking(null);
    }
  }, [connectionId, path, naming, logical]);

  useEffect(() => {
    void refresh();
    return onAutoLock(() => {
      // Locked by itself after a quiet period: what was decrypted goes with it.
      setShown(null);
      asked.current = false;
      void refresh();
    });
  }, [refresh]);

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

  const hide = () => {
    setShown(null);
    asked.current = true; // hidden on purpose: not opened again until asked
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

      {shown?.kind === "text" ? (
        <>
          <p className={styles.itemMeta}>
            Decrypted in this browser: {shown.name}. It is read-only for now, and nothing of it leaves this page.
          </p>
          <NoteEditor aria-label={shown.name} value={shown.text} readOnly />
          <div className={styles.actions}>
            <Button type="button" variant="ghost" onClick={hide}>
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
            <Button type="button" variant="ghost" onClick={hide}>
              Hide
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
