"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { keyStore, onAutoLock } from "../client";
import { KeyError, MIN_PASSPHRASE_LENGTH, type Status } from "../store";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/**
 * The age identity in this browser (ROADMAP 2a.1): make one, bring one you have, unlock it with its passphrase, lock it, or remove it. It is kept in
 * this browser only and sealed with the passphrase; nothing typed here is sent to the server.
 */
export function KeyManager() {
  const [status, setStatus] = useState<Status | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [existing, setExisting] = useState("");
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await keyStore().status());
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : "This browser would not open its key storage, so no identity can be kept here.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAutoLock(() => {
      setNotice("The identity locked itself after a quiet period. Unlock it to use it again.");
      void refresh();
    });
  }, [refresh]);

  /** Run something slow with a message showing: sealing and opening take a second or two, during which the page is busy. */
  async function run(message: string, act: () => Promise<void>) {
    setError(null);
    setNotice(null);
    setWorking(message);
    // Let the message paint before the page is busy.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await act();
      setPassphrase("");
      setExisting("");
      setImporting(false);
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : "Something went wrong with the identity. Nothing was kept.");
    } finally {
      setWorking(null);
      await refresh();
    }
  }

  const onCreate = (event: FormEvent) => {
    event.preventDefault();
    void run("Making the identity…", async () => void (await keyStore().create(passphrase)));
  };
  const onImport = (event: FormEvent) => {
    event.preventDefault();
    void run("Keeping the identity…", async () => void (await keyStore().import(existing, passphrase)));
  };
  const onUnlock = (event: FormEvent) => {
    event.preventDefault();
    void run("Unlocking…", async () => void (await keyStore().unlock(passphrase)));
  };
  const onLock = () => {
    keyStore().lock();
    setNotice(null);
    void refresh();
  };
  const onRemove = () => {
    if (!window.confirm("Remove this identity from this browser? Without a copy of its secret key, what is encrypted to it can no longer be read. Nothing in any repository changes.")) return;
    void run("Removing…", async () => keyStore().remove());
  };

  const busy = working !== null;
  const phrase = (
    <FormField label="Passphrase" hint={`At least ${MIN_PASSPHRASE_LENGTH} characters. It cannot be recovered: forget it and the identity in this browser is lost.`} required>
      {(field) => <Input {...field} type="password" autoComplete="new-password" minLength={MIN_PASSPHRASE_LENGTH} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={busy} />}
    </FormField>
  );

  return (
    <section className={styles.section} aria-labelledby="keys-title">
      <h2 id="keys-title">Encryption identity</h2>
      <p>
        An age identity opens the encrypted files that were encrypted to its public key. It is kept in <strong>this browser only</strong>, sealed with a passphrase, and is never sent to the
        server: whoever runs this instance cannot read what you encrypt.
      </p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <div className={styles.notice}>
          <Alert variant="info">{notice}</Alert>
        </div>
      ) : null}
      {working ? (
        <div className={styles.notice} role="status">
          <Alert variant="info">{working} This takes a moment.</Alert>
        </div>
      ) : null}

      {status === null ? <p>Looking…</p> : null}

      {status?.state === "none" ? (
        importing ? (
          <form className={styles.form} onSubmit={onImport} style={{ marginTop: 0 }}>
            <FormField label="Your secret key" hint="Paste the file's text or its AGE-SECRET-KEY-1… line. Only the key is kept." required>
              {(field) => <textarea {...field} rows={4} autoComplete="off" spellCheck={false} value={existing} onChange={(e) => setExisting(e.target.value)} disabled={busy} />}
            </FormField>
            {phrase}
            <div className={styles.actions}>
              <Button type="submit" loading={busy}>
                Keep this identity
              </Button>
              <Button type="button" variant="ghost" onClick={() => setImporting(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <form className={styles.form} onSubmit={onCreate} style={{ marginTop: 0 }}>
            {phrase}
            <div className={styles.actions}>
              <Button type="submit" loading={busy}>
                Make an identity
              </Button>
              <Button type="button" variant="ghost" onClick={() => setImporting(true)} disabled={busy}>
                I already have one
              </Button>
            </div>
          </form>
        )
      ) : null}

      {status && status.state !== "none" ? (
        <>
          <p>
            Public key (add it to a vault's recipients; it is not a secret):
            <br />
            <code data-testid="recipient">{status.recipient}</code>
          </p>
          {status.state === "locked" ? (
            <form className={styles.form} onSubmit={onUnlock} style={{ marginTop: 0 }}>
              <FormField label="Passphrase" required>
                {(field) => <Input {...field} type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={busy} />}
              </FormField>
              <div className={styles.actions}>
                <Button type="submit" loading={busy}>
                  Unlock
                </Button>
                <Button type="button" variant="ghost" onClick={onRemove} disabled={busy}>
                  Remove from this browser
                </Button>
              </div>
            </form>
          ) : (
            <div className={styles.actions}>
              <span role="status">Unlocked. It locks again after fifteen minutes without use, or when you close this tab.</span>
              <Button type="button" onClick={onLock}>
                Lock
              </Button>
              <Button type="button" variant="ghost" onClick={onRemove} disabled={busy}>
                Remove from this browser
              </Button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
