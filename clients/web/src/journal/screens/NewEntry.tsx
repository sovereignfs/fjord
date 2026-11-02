"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { repositoryHref } from "../../browse/links";
import { type CreateAttempt, sendCreateEncrypted, sendEntry } from "../../files/client";
import { loadModule } from "../../keys/module";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { MAX_TITLE_CHARS } from "../../files/limits";
import { newEncryptedEntry } from "../seal";

/**
 * "New entry" (ROADMAP 3b.1): a note dated now in this browser's own time, with a title if one is typed, then opened in the note editor. In a
 * plaintext journal the server writes it where `fjord-core` files it; in an encrypted one it is written and encrypted here, to the journal's
 * recipients, and the server is given only the ciphertext.
 */
export function NewEntry({ connectionId, vault, encrypted }: { connectionId: number; vault: string; /** The journal's recipients, when it is encrypted, or why it cannot be written to. */ encrypted?: { ok: true; text: string } | { ok: false; message: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (encrypted && !encrypted.ok) {
    return (
      <Alert variant="info" heading="New entries cannot be written here yet">
        {encrypted.message}
      </Alert>
    );
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let made: CreateAttempt;
    if (encrypted?.ok) {
      try {
        const sealed = newEncryptedEntry(await loadModule(), { title, recipients: encrypted.text, now: new Date(), random: crypto.getRandomValues(new Uint8Array(16)) });
        made = await sendCreateEncrypted(connectionId, { vault, folder: "", kind: "note", title: "", ciphertext: sealed.ciphertext });
      } catch {
        made = { ok: false, message: "The entry could not be encrypted here, so nothing was made." };
      }
    } else {
      made = await sendEntry(connectionId, title);
    }
    if (made.ok) {
      router.push(repositoryHref(connectionId, ...made.path.split("/")));
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  if (!open) {
    return (
      <p>
        <Button onClick={() => setOpen(true)}>New entry</Button>
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="New entry" style={{ marginTop: 0 }}>
      <FormField label="Title" hint="Optional. The entry is dated now, in your own time; the date can be changed later.">
        {(field) => <Input {...field} name="title" autoComplete="off" autoFocus maxLength={MAX_TITLE_CHARS} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />}
      </FormField>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="No entry was made">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={busy}>
          Write it
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
