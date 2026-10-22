"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { authClient } from "../../client";
import { messageFor } from "../../messages";
import { Alert, Button, FormField, Input } from "../../../ui";
import styles from "../screens.module.css";

interface Passkey {
  id: string;
  name?: string | null | undefined;
  createdAt?: Date | string | null | undefined;
  deviceType?: string | null | undefined;
}

/** The passkeys that can sign this account in: see them, add one, remove one. */
export function PasskeysSection() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: failure } = await authClient.passkey.listUserPasskeys();
    if (failure) setError(messageFor(failure));
    else setPasskeys((data ?? []) as Passkey[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.passkey.addPasskey({ name: name.trim() || "Passkey" });
    setBusy(false);
    if (failure) {
      setError(messageFor(failure, "The passkey was not added."));
      return;
    }
    setName("");
    await load();
  }

  async function onDelete(passkey: Passkey) {
    if (!window.confirm(`Remove the passkey "${passkey.name ?? "Passkey"}"? You will not be able to sign in with it any more.`)) return;
    setError(null);
    const { error: failure } = await authClient.passkey.deletePasskey({ id: passkey.id });
    if (failure) setError(messageFor(failure));
    else await load();
  }

  return (
    <section className={styles.section} aria-labelledby="passkeys-title">
      <h2 id="passkeys-title">Passkeys</h2>
      <p>Sign in with your fingerprint, face or a security key instead of a password. Nothing secret leaves your device.</p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {passkeys && passkeys.length > 0 ? (
        <ul className={styles.list} aria-label="Your passkeys">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className={styles.item}>
              <span>
                {passkey.name ?? "Passkey"}
                {passkey.createdAt ? <span className={styles.itemMeta}> · added {new Date(passkey.createdAt).toLocaleDateString()}</span> : null}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onDelete(passkey)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className={styles.form} onSubmit={onAdd} style={{ marginTop: 0 }}>
        <FormField label="Name for the new passkey" hint="Something that tells you which device it is on.">
          {(field) => <Input {...field} placeholder="Work laptop" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" loading={busy}>
            Add a passkey
          </Button>
        </div>
      </form>
    </section>
  );
}
