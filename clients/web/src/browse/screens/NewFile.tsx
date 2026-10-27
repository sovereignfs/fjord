"use client";

import { type FormEvent, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { sendCreate } from "../../files/client";
import { repositoryHref } from "../links";

/**
 * "New note" and "New document" in a folder of a plaintext vault (ROADMAP 1b.7). A person gives a title, and no more: the
 * file's name and, for a document, its header are `fjord-core`'s, made on the server. A note may have no title (it is then
 * named after the date and time); a document needs one. The new file opens in its editor.
 */
export function NewFile({ connectionId, vault, folder }: { connectionId: number; vault: string; folder: string }) {
  const [kind, setKind] = useState<"note" | "document" | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (kind === null) return;
    setBusy(true);
    setError(null);
    const made = await sendCreate(connectionId, { vault, folder, kind, title });
    if (made.ok) {
      window.location.assign(repositoryHref(connectionId, ...made.path.split("/")));
      return;
    }
    setError(made.message);
    setBusy(false);
  }

  if (kind === null) {
    return (
      <p>
        <Button variant="secondary" size="sm" onClick={() => setKind("note")}>
          New note
        </Button>{" "}
        <Button variant="secondary" size="sm" onClick={() => setKind("document")}>
          New document
        </Button>
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} style={{ marginTop: 0 }} aria-label={kind === "note" ? "New note" : "New document"}>
      <FormField label="Title" hint={kind === "note" ? "Optional. It names the file; left empty, the note is named after the date and time." : "The document's title; it names the file."} required={kind === "document"}>
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
          {kind === "note" ? "Create note" : "Create document"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => (setKind(null), setError(null), setTitle(""))} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
