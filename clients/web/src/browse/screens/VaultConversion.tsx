'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Button, FormField, Input } from '../../ui';
import styles from '../../auth/screens/screens.module.css';
import { fetchVaultSnapshot, sendConvert } from '../../files/client';
import { keyStore } from '../../keys/client';
import { decryptFiles, encryptFiles } from '../../keys/convert';
import { loadModule } from '../../keys/module';
import { KeyError, type Status } from '../../keys/store';
import { ActionDialog } from './ActionDialog';

/**
 * Make this vault encrypted, or plaintext again (RFC 0003, `fjord encrypt <vault> --permanent` and `fjord decrypt <vault> --permanent` on the command line). There is no checkout here: a browser
 * opens an encrypted file, edits it and seals it again one at a time, so what a person can do with the whole vault is change what it is.
 *
 * The server has no key, so this page does the work that only it can: it reads every file of the vault, encrypts it to your key and **opens it again to prove it is the file it was made from**
 * (or decrypts it), and sends the lot to be committed at once. It needs your key unlocked, for the proof when encrypting and for the files themselves when decrypting.
 *
 * It asks first, and says what cannot be undone: what was committed before stays in the repository's history, and decrypting puts the files in a commit where everyone who can read the repository
 * can read them.
 */
export function VaultConversion({
  connectionId,
  vault,
  encrypted,
}: {
  connectionId: number;
  vault: string;
  encrypted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await keyStore().status());
    } catch {
      setError(
        'This browser would not open its key storage, so nothing can be encrypted or decrypted here.',
      );
    }
  }, []);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const verb = encrypted ? 'Make this vault plaintext' : 'Encrypt this vault';

  const trigger = (
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
      {verb}…
    </Button>
  );

  async function onUnlock(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setWorking('Unlocking…');
    try {
      await keyStore().unlock(passphrase);
      setPassphrase('');
      await refresh();
    } catch (failure) {
      setError(failure instanceof KeyError ? failure.message : 'That did not unlock the identity.');
    } finally {
      setWorking(null);
    }
  }

  async function go() {
    setError(null);
    setWorking('Reading the vault…');
    try {
      const snapshot = await fetchVaultSnapshot(connectionId, vault);
      if (!snapshot.ok) {
        setError(snapshot.message);
        return;
      }
      if (snapshot.encrypted !== encrypted) {
        setError(
          snapshot.encrypted
            ? 'This vault is already encrypted. Reload the page.'
            : 'This vault is not encrypted. Reload the page.',
        );
        return;
      }
      const store = keyStore();
      const current = await store.status();
      if (current.state !== 'unlocked') {
        setError('Your key is locked. Unlock it, then try again.');
        return;
      }
      setWorking(
        encrypted ? 'Decrypting the files…' : 'Encrypting the files, and checking each opens…',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const module = await loadModule();
      const files = encrypted
        ? decryptFiles(module, store, { files: snapshot.files, naming: snapshot.naming })
        : encryptFiles(module, store, {
            files: snapshot.files,
            recipients: `${current.recipient}\n`,
          });
      setWorking('Committing…');
      const made = await sendConvert(connectionId, {
        vault,
        direction: encrypted ? 'decrypt' : 'encrypt',
        ...(encrypted ? {} : { recipients: [current.recipient] }),
        files,
      });
      if (!made.ok) {
        setError(made.message);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof KeyError
          ? failure.message
          : 'The files could not be prepared here, so nothing was changed.',
      );
    } finally {
      setWorking(null);
      setConfirming(false);
    }
  }

  const busy = working !== null;
  if (!open) return trigger;
  return (
    <>
      {trigger}
      <ActionDialog
        open
        onClose={
          busy ? () => undefined : () => (setOpen(false), setConfirming(false), setError(null))
        }
        title={verb}
      >
        <section className={styles.form} aria-label={verb} data-testid="vault-conversion">
          <p>
            {encrypted
              ? 'This turns the vault into a plaintext one: every file is decrypted here, in your browser, and committed as it is, and the encrypted copies are removed. Your key must open every file.'
              : "This turns the vault into an encrypted one: every file is encrypted here, in your browser, to your key, checked to open again, and committed in place of the plain one. Add other people's keys afterwards, on the vault's recipients."}
          </p>
          {status === null ? null : status.state === 'none' ? (
            <Alert variant="info" heading="No identity in this browser">
              Make or bring an age identity on the{' '}
              <a href="/account?section=security&tab=keys">Keys page</a> first. It stays in this
              browser.
            </Alert>
          ) : status.state === 'locked' ? (
            <form className={styles.form} onSubmit={onUnlock} style={{ marginTop: 0 }}>
              <FormField label="Passphrase" required>
                {(field) => (
                  <Input
                    {...field}
                    type="password"
                    autoComplete="current-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    disabled={busy}
                  />
                )}
              </FormField>
              <div className={styles.actions}>
                <Button type="submit" loading={busy} size="sm">
                  Unlock
                </Button>
              </div>
            </form>
          ) : confirming ? (
            <div className={styles.notice}>
              <Alert
                variant="warning"
                heading={
                  encrypted
                    ? 'This puts the plain text of every file in the repository'
                    : 'The plain text stays in the history'
                }
              >
                {encrypted
                  ? 'Everyone who can read the repository will be able to read these files, from this commit on and in its history. The encrypted copies stay in the history too.'
                  : "The files are encrypted from this commit on. The repository's earlier commits still hold their plain text, and anyone who has a copy of the repository has it. This does not unpublish anything."}
              </Alert>
            </div>
          ) : null}
          {error ? (
            <div className={styles.notice}>
              <Alert variant="error" heading="Nothing was changed">
                {error}
              </Alert>
            </div>
          ) : null}
          <div className={styles.actions}>
            {status?.state === 'unlocked' ? (
              <Button
                type="button"
                size="sm"
                loading={busy}
                variant={confirming ? 'primary' : 'secondary'}
                onClick={() => (confirming ? void go() : setConfirming(true))}
              >
                {confirming ? (encrypted ? 'Yes, make it plaintext' : 'Yes, encrypt it') : verb}
              </Button>
            ) : null}{' '}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => (setOpen(false), setConfirming(false), setError(null))}
            >
              Cancel
            </Button>
          </div>
          {working ? (
            <p className={styles.itemMeta} role="status">
              {working}
            </p>
          ) : null}
        </section>
      </ActionDialog>
    </>
  );
}
