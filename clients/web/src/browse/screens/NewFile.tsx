"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { sendCreate, sendCreateEncrypted } from "../../files/client";
import { keyStore } from "../../keys/client";
import { type Naming, newEncryptedFile } from "../../keys/files";
import { loadModule } from "../../keys/module";
import { repositoryHref } from "../links";

/** What a new file in an encrypted vault is made with: how the vault names its files, and the text of its recipients file (or why there is none). */
export interface EncryptedCreate {
  naming: Naming;
  recipients: { ok: true; text: string } | { ok: false; message: string };
}

/**
 * "New document" in a folder of a plaintext vault (ROADMAP 1b.7). A person gives a title, and no more: the file's name and its
 * header are `fjord-core`'s, made on the server. A title is optional (the file is then named after the date and time). The new
 * file opens in its editor.
 *
 * In an encrypted vault (ROADMAP 2b.4, `encrypted`) the file is written and **encrypted here**, to the vault's recipients, and only the ciphertext is sent (with
 * the title, for a vault whose file names are public, as they are made from it). Encrypting needs only public keys, so it works with the identity locked; the new
 * file then opens by client navigation, which keeps an unlocked identity unlocked.
 */
export function NewFile({ connectionId, vault, folder, encrypted }: { connectionId: number; vault: string; folder: string; encrypted?: EncryptedCreate }) {
  const router = useRouter();
  // The identity's public key, if there is one in this browser: it is warned about when the vault's recipients do not list it.
  const [mine, setMine] = useState<string | null>(null);
  useEffect(() => {
    if (!encrypted) return;
    void keyStore()
      .status()
      .then((status) => setMine(status.state === "none" ? null : status.recipient))
      .catch(() => setMine(null));
  }, [encrypted]);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!open) return;
    setBusy(true);
    setError(null);
    let made: Awaited<ReturnType<typeof sendCreate>>;
    if (encrypted?.recipients.ok) {
      try {
        const sealed = newEncryptedFile(await loadModule(), { title, naming: encrypted.naming, recipients: encrypted.recipients.text, when: localMinute(new Date()), now: Date.now(), random: crypto.getRandomValues(new Uint8Array(16)) });
        made = sealed.ok
          ? await sendCreateEncrypted(connectionId, { vault, folder, title: encrypted.naming === "plain" ? title.trim() : "", ciphertext: sealed.ciphertext })
          : { ok: false, message: "A title needs some letters or digits in it to name its file by." };
      } catch {
        made = { ok: false, message: "The file could not be encrypted here, so nothing was made." };
      }
    } else {
      made = await sendCreate(connectionId, { vault, folder, title });
    }
    if (made.ok) {
      const href = repositoryHref(connectionId, ...made.path.split("/"));
      if (encrypted) router.push(href);
      else window.location.assign(href);
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  if (encrypted && !encrypted.recipients.ok) {
    return (
      <Alert variant="info" heading="New files cannot be made here yet">
        {encrypted.recipients.message}
      </Alert>
    );
  }

  if (!open) {
    return (
      <p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          New document
        </Button>
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} style={{ marginTop: 0 }} aria-label="New document">
      {encrypted?.recipients.ok && mine !== null && !encrypted.recipients.text.includes(mine) ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading="Your key is not among this vault's recipients">
            A file made now is encrypted to the recipients in the vault&apos;s recipients file, which does not list your key: you could not open it afterwards.
          </Alert>
        </div>
      ) : null}
      {encrypted ? <p className={styles.itemMeta}>{encrypted.naming === "plain" ? "The file is encrypted here, in this browser. Its name is public, as every file name in this vault is; its contents are not." : "The file is encrypted here, in this browser. Its name is kept inside it; the repository sees only a new identifier."}</p> : null}
      <FormField label="Title" hint="Optional. It names the file; left empty, the file is named after the date and time.">
        {(field) => <Input {...field} name="title" autoComplete="off" maxLength={200} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />}
      </FormField>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was made">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={busy}>
          Create document
        </Button>
        <Button type="button" variant="secondary" onClick={() => (setOpen(false), setError(null), setTitle(""))} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const localMinute = (now: Date) => ({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() });
