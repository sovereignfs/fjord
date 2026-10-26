"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Alert, Badge, Button, FormField, Icon, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { SetupPreview } from "../setup";

/**
 * The offer to set up a repository that is not a Fjord repository (ROADMAP 1a.10, DESIGN.md §7): what would be
 * added, shown first, and nothing written before the button. The server made the preview and, when the button is
 * pressed, makes the plan again on the repository as it then is; all that is sent is the vault's name.
 */
export function SetupOffer({ connectionId, preview }: { connectionId: number; preview: SetupPreview }) {
  const router = useRouter();
  const [vault, setVault] = useState(preview.vault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The preview was made for its own vault name; a different name changes only the folder the vault's files are in.
  const shown = preview.files.map((file) => (file.path.startsWith(`${preview.vault}/`) ? { ...file, path: `${vault.trim() || "…"}/${file.path.slice(preview.vault.length + 1)}` } : file));
  const appends = preview.files.some((file) => file.change === "append");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault: vault.trim() }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setError(body?.error?.message ?? "The repository was not set up. Nothing was written. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach this server. Nothing was written. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="setup-title">
      <h2 id="setup-title">This is not a Fjord repository yet</h2>
      <p>
        It has no <code>fjord.json</code> and no vaults. Fjord can set it up with one commit on <strong>{preview.branch}</strong> that adds only what it needs.
        Nothing that is already here is changed or removed{appends ? ", except that one line is added to the end of your .gitattributes, which the format requires" : ""}. Nothing is
        written until you press the button.
      </p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <form className={styles.form} onSubmit={onSubmit} style={{ marginTop: 0 }}>
        <FormField label="Vault name" hint="A folder at the top of the repository where your documents and notes will live. It is not encrypted: anyone who can read the repository can read it." required>
          {(field) => <Input {...field} name="vault" autoComplete="off" value={vault} onChange={(e) => setVault(e.target.value)} disabled={busy} />}
        </FormField>
        <ul className={styles.list} aria-label="What would be added">
          {shown.map((file) => (
            <li key={file.path} className={styles.item}>
              <span>
                <Icon name="file-text" aria-hidden /> <code>{file.path}</code>{" "}
                <Badge>{file.change === "append" ? "One line added" : "New"}</Badge>
              </span>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <Button type="submit" loading={busy}>
            Set up Fjord here
          </Button>
        </div>
      </form>
    </section>
  );
}
