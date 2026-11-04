"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { keyStore } from "../../keys/client";
import { Alert, Badge, Button, FormField, Icon, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { ChoicePreview, SetupPreview } from "../setup";

type Kind = "drive" | "journal" | "ssg";

/**
 * The offer to set up a repository that is not a Fjord repository (ROADMAP 1a.10, 3a.3; DESIGN.md §7, §8): what it is to be, a drive,
 * a journal or a site (spec §3.1), what that would add, shown first, and nothing written before the button. The server made each
 * preview and, when the button is pressed, makes the plan again on the repository as it then is; all that is sent is the choices.
 *
 * An encrypted journal is made with this browser's own public key, when it has one, so it can be written to at once; a site is never
 * offered encryption, because its content is published.
 */
export function SetupOffer({ connectionId, preview }: { connectionId: number; preview: SetupPreview }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("drive");
  const [vault, setVault] = useState(preview.vault);
  const [journalVault, setJournalVault] = useState(preview.journalVault);
  // A journal is personal, so it is offered encrypted first (spec §3.1, RFC 0002); plaintext is a choice the person makes.
  const [encrypted, setEncrypted] = useState(true);
  const [engine, setEngine] = useState<"astro" | "jekyll">(preview.adoptSite?.engine ?? "astro");
  // A site that is already here is offered as it is, first: nothing of it is changed or moved (RFC 0002).
  const [adopting, setAdopting] = useState(preview.adoptSite !== null);
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This browser's public key, if it has an identity: an encrypted journal is written to it (it is not a secret).
  useEffect(() => {
    if (kind !== "journal" || !encrypted || mine !== null) return;
    void keyStore()
      .status()
      .then((status) => {
        if (status.state !== "none") setMine(status.recipient);
      })
      .catch(() => undefined);
  }, [kind, encrypted, mine]);

  // Each preview was made for its own vault name; a different name changes only the folder the vault's files are in.
  const renamed = (files: { path: string; change: "create" | "append" }[], from: string, to: string) =>
    files.map((file) => (file.path.startsWith(`${from}/`) ? { ...file, path: `${to.trim() || "…"}/${file.path.slice(from.length + 1)}` } : file));
  const chosen: ChoicePreview =
    kind === "drive"
      ? { files: renamed(preview.files, preview.vault, vault) }
      : kind === "journal"
        ? withFiles(encrypted ? preview.kinds.encryptedJournal : preview.kinds.journal, (files) => renamed(files, preview.journalVault, journalVault))
        : adopting && preview.adoptSite
          ? preview.adoptSite.preview
          : preview.kinds[engine];
  const appends = "files" in chosen && chosen.files.some((file) => file.change === "append");
  const needsKey = kind === "journal" && encrypted && mine === null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body =
      kind === "drive"
        ? { vault: vault.trim() }
        : kind === "journal"
          ? { kind, vault: journalVault.trim(), encrypted, recipients: encrypted && mine !== null ? [mine] : [] }
          : adopting && preview.adoptSite
            ? { kind, engine: preview.adoptSite.engine, adopt: preview.adoptSite.content }
            : { kind, engine };
    try {
      const response = await fetch(`/api/connections/${connectionId}/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setError(answer?.error?.message ?? "The repository was not set up. Nothing was written. Try again.");
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
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
          <legend>What it is for</legend>
          <label style={{ display: "block" }}>
            <input type="radio" name="kind" checked={kind === "drive"} onChange={() => setKind("drive")} /> A drive: vaults and folders of documents and notes
          </label>
          <label style={{ display: "block" }}>
            <input type="radio" name="kind" checked={kind === "journal"} onChange={() => setKind("journal")} /> A journal: dated entries, read as a timeline
          </label>
          <label style={{ display: "block" }}>
            <input type="radio" name="kind" checked={kind === "ssg"} onChange={() => setKind("ssg")} /> A site: the posts of a static site, built by Astro or Jekyll
          </label>
        </fieldset>

        {kind === "drive" ? (
          <FormField label="Vault name" hint="A folder at the top of the repository where your documents and notes will live. It is not encrypted: anyone who can read the repository can read it." required>
            {(field) => <Input {...field} name="vault" autoComplete="off" value={vault} onChange={(e) => setVault(e.target.value)} disabled={busy} />}
          </FormField>
        ) : null}

        {kind === "journal" ? (
          <>
            <FormField label="Folder" hint="The folder at the top of the repository the entries are kept in." required>
              {(field) => <Input {...field} name="journal" autoComplete="off" value={journalVault} onChange={(e) => setJournalVault(e.target.value)} disabled={busy} />}
            </FormField>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
              <legend>Who can read it</legend>
              <label style={{ display: "block" }}>
                <input type="radio" name="protection" checked={encrypted} onChange={() => setEncrypted(true)} /> Only you, with your key (encrypted: no entry's date, title or tags shows)
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="protection" checked={!encrypted} onChange={() => setEncrypted(false)} /> Anyone who can read the repository (plaintext)
              </label>
            </fieldset>
            {needsKey ? (
              <p className={styles.itemMeta}>
                You have no key in this browser yet. <a href="/security?tab=keys">Make or import one</a>: an encrypted journal is written to it. Until you have, choose plaintext to set it up now.
              </p>
            ) : null}
          </>
        ) : null}

        {kind === "ssg" && preview.adoptSite ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
            <legend>This looks like {preview.adoptSite.engine === "astro" ? "an Astro" : "a Jekyll"} site</legend>
            <label style={{ display: "block" }}>
              <input type="radio" name="adopt" checked={adopting} onChange={() => setAdopting(true)} /> Use it as it is: <code>{preview.adoptSite.content}</code> becomes the vault, where the site already reads its content. Nothing of it is changed or moved.
            </label>
            <label style={{ display: "block" }}>
              <input type="radio" name="adopt" checked={!adopting} onChange={() => setAdopting(false)} /> Start a new site here instead
            </label>
          </fieldset>
        ) : null}

        {kind === "ssg" && !adopting ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
            <legend>Built with</legend>
            <label style={{ display: "block" }}>
              <input type="radio" name="engine" checked={engine === "astro"} onChange={() => setEngine("astro")} /> Astro
            </label>
            <label style={{ display: "block" }}>
              <input type="radio" name="engine" checked={engine === "jekyll"} onChange={() => setEngine("jekyll")} /> Jekyll
            </label>
            <p className={styles.itemMeta}>A site is published, so its content is never encrypted. Fjord edits it; your host builds and publishes it.</p>
          </fieldset>
        ) : null}

        {"files" in chosen ? (
          <ul className={styles.list} aria-label="What would be added">
            {chosen.files.map((file) => (
              <li key={file.path} className={styles.item}>
                <span>
                  <Icon name="file-text" aria-hidden /> <code>{file.path}</code> <Badge>{file.change === "append" ? "One line added" : "New"}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.notice}>
            <Alert variant="warning" heading="This cannot be set up here">
              {chosen.refused}
            </Alert>
          </div>
        )}
        <div className={styles.actions}>
          <Button type="submit" loading={busy} disabled={!("files" in chosen) || needsKey}>
            Set up Fjord here
          </Button>
        </div>
      </form>
    </section>
  );
}

function withFiles(preview: ChoicePreview, map: (files: { path: string; change: "create" | "append" }[]) => { path: string; change: "create" | "append" }[]): ChoicePreview {
  return "files" in preview ? { files: map(preview.files) } : preview;
}
