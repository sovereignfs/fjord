"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { keyStore } from "../../keys/client";
import { Alert, Badge, Button, FormField, Icon, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/**
 * Adding a vault to a Fjord repository (ROADMAP 2d.1, DESIGN.md §7): a name, plaintext or encrypted, and for an encrypted one how its
 * files are named and who can open them. The list of files is what `fjord vault add` would write; the plan itself is made again by
 * the server, from `fjord-core`, on the repository as it is when the button is pressed, and all that is sent is these choices.
 *
 * An encrypted vault is made with at least one key, so that it is writable at once: this browser's own public key is put in the list
 * when there is one (it is not a secret), and the person can add others, one to a line.
 */
export function AddVault({ connectionId, existing }: { connectionId: number; /** The directories of the vaults already there, to warn of a name that is taken before the button. */ existing: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [encrypted, setEncrypted] = useState(false);
  const [idNaming, setIdNaming] = useState(false);
  const [keys, setKeys] = useState("");
  const [mine, setMine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This browser's public key, if it has an identity: it goes in the list the first time an encrypted vault is chosen.
  useEffect(() => {
    if (!open || !encrypted || mine !== null) return;
    void keyStore()
      .status()
      .then((status) => {
        if (status.state === "none") return;
        setMine(status.recipient);
        setKeys((current) => (current.trim() === "" ? status.recipient : current));
      })
      .catch(() => undefined);
  }, [open, encrypted, mine]);

  const trimmed = name.trim();
  const taken = trimmed !== "" && existing.some((directory) => directory.toLowerCase() === trimmed.toLowerCase());
  const recipients = keys.split(/\s+/).filter((key) => key !== "");
  const folder = trimmed || "…";
  const files = [
    { path: "fjord.json", note: "Lists the vault" },
    { path: `${folder}/fjord.vault.json`, note: "New" },
    ...(encrypted
      ? [
          { path: `${folder}/recipients.txt`, note: "New" },
          { path: `${folder}/.gitignore`, note: "New" },
          { path: ".gitattributes", note: "One line added, if it lacks it" },
        ]
      : []),
  ];

  function reset() {
    setOpen(false);
    setName("");
    setEncrypted(false);
    setIdNaming(false);
    setKeys("");
    setError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/vaults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, encrypted, idNaming: encrypted && idNaming, recipients: encrypted ? recipients : [] }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setError(body?.error?.message ?? "The vault was not added. Nothing was written. Try again.");
        return;
      }
      reset();
      router.refresh();
    } catch {
      setError("Could not reach this server. Nothing was written. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Add a vault
        </Button>
      </p>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="Add a vault" style={{ marginTop: 0 }}>
      <FormField label="Vault name" hint="A folder at the top of the repository. It is also the vault's name." required error={taken ? "Something here already has that name, case aside." : undefined}>
        {(field) => <Input {...field} name="name" autoComplete="off" maxLength={255} autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />}
      </FormField>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
        <legend>Who can read it</legend>
        <label style={{ display: "block" }}>
          <input type="radio" name="protection" checked={!encrypted} onChange={() => setEncrypted(false)} /> Anyone who can read the repository (plaintext)
        </label>
        <label style={{ display: "block" }}>
          <input type="radio" name="protection" checked={encrypted} onChange={() => setEncrypted(true)} /> Only the people whose keys you list (encrypted)
        </label>
      </fieldset>
      {encrypted ? (
        <>
          <label style={{ display: "block" }}>
            <input type="checkbox" checked={idNaming} onChange={(e) => setIdNaming(e.target.checked)} disabled={busy} /> Hide file names too: name every file by an identifier
          </label>
          <label htmlFor="add-vault-keys">Public keys (<code>age1…</code>), one to a line</label>
          <textarea
            id="add-vault-keys"
            name="recipients"
            rows={3}
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            style={{ width: "100%", font: "var(--sv-font-mono, monospace)", background: "var(--sv-color-surface, transparent)", color: "inherit", border: "1px solid var(--sv-color-border, currentColor)", borderRadius: "var(--sv-radius-md, 4px)", padding: "var(--sv-space-2, 0.5rem)" }}
          />
          <p className={styles.itemMeta}>
            {mine === null ? (
              <>
                You have no key in this browser yet. <a href="/account/keys">Make or import one</a> to put yours here; a vault needs at least one key to be written to.
              </>
            ) : (
              "Your own key is listed. Only public keys go here; a public key is not a secret, and a secret key is refused."
            )}
          </p>
        </>
      ) : null}
      <ul className={styles.list} aria-label="What would be written">
        {files.map((file) => (
          <li key={file.path} className={styles.item}>
            <span>
              <Icon name="file-text" aria-hidden /> <code>{file.path}</code> <Badge>{file.note}</Badge>
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was written">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={busy} disabled={trimmed === "" || taken || (encrypted && recipients.length === 0)}>
          Add vault
        </Button>
        <Button type="button" variant="secondary" onClick={reset} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
