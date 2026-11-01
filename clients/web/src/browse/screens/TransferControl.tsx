"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import { fetchRecipients, sendTransfer } from "../../files/client";
import { keyStore } from "../../keys/client";
import { type Recipients, type TransferTarget, prepareTransfer } from "../../keys/files";
import { loadModule } from "../../keys/module";
import { repositoryHref } from "../links";

/**
 * "Move to another vault" for a file when one of the two vaults is encrypted (ROADMAP 2b.6, DESIGN.md §8). The server has no key, so this page does the one thing
 * only it can: it has the file's text (a plaintext note it was given, or an encrypted file it has decrypted), and makes the bytes that belong in the other vault, the
 * text for a plaintext one and ciphertext for an encrypted one. The server then takes the source away and adds those bytes in one commit.
 *
 * It asks first, and says what happens that cannot be undone: moving into an encrypted vault leaves the plain text in the repository's earlier commits; moving out of
 * one puts the plain text in a commit, where everyone who can read the repository can read it.
 */
export function TransferControl({
  connectionId,
  path,
  blob,
  name,
  text,
  sourceEncrypted,
  targets,
  blocked,
}: {
  connectionId: number;
  /** The file, repository-relative. */
  path: string;
  /** The version of it that `text` is of. */
  blob: string;
  /** The file's real name, with its extension. */
  name: string;
  text: string;
  sourceEncrypted: boolean;
  targets: TransferTarget[];
  /** Why it cannot be moved now, such as unsaved changes. */
  blocked?: string | undefined;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(0);
  const [newName, setNewName] = useState(name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  // The recipients of an encrypted vault are asked for when one is chosen, so that opening a file reads nothing for them.
  const [recipients, setRecipients] = useState<Record<string, Recipients>>({});
  const target = targets[choice];
  const vaultOfTarget = target?.vault;
  const needsRecipients = target?.to.form === "encrypted";

  useEffect(() => {
    if (!open) return;
    void keyStore()
      .status()
      .then((status) => setMine(status.state === "none" ? null : status.recipient))
      .catch(() => setMine(null));
  }, [open]);

  useEffect(() => {
    if (!open || !needsRecipients || vaultOfTarget === undefined || recipients[vaultOfTarget]) return;
    let current = true;
    void fetchRecipients(connectionId, vaultOfTarget).then((found) => current && setRecipients((now) => ({ ...now, [vaultOfTarget]: found })));
    return () => {
      current = false;
    };
  }, [open, needsRecipients, vaultOfTarget, recipients, connectionId]);

  if (targets.length === 0) return null;
  if (blocked) return <p className={styles.itemMeta}>{blocked}</p>;
  if (!open) {
    return (
      <p>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Move to another vault
        </Button>
      </p>
    );
  }

  const toEncrypted = target?.to.form === "encrypted";
  const idNamed = target?.to.form === "encrypted" && target.to.naming === "id";
  const label = (candidate: TransferTarget) => `${candidate.folder}${candidate.to.form === "encrypted" ? " (encrypted)" : ""}`;

  async function go() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = prepareTransfer(await loadModule(), { text, name: newName.trim(), to: target.to, recipients: recipients[target.vault], now: Date.now(), random: crypto.getRandomValues(new Uint8Array(16)) });
      if (!prepared.ok) {
        setError(prepared.message);
        return;
      }
      const made = await sendTransfer(connectionId, { path, blob, destination: `${target.folder}/${prepared.leaf}`, content: prepared.content });
      if (made.ok) {
        router.push(repositoryHref(connectionId, ...made.path.split("/")));
        return;
      }
      setError(made.message);
    } catch {
      setError("The file could not be prepared here, so nothing was moved.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <form
      className={styles.form}
      aria-label="Move to another vault"
      onSubmit={(event) => {
        event.preventDefault();
        if (confirming) void go();
        else setConfirming(true);
      }}
    >
      <FormField label="Move to">
        {(field) => (
          <select
            {...field}
            name="place"
            value={choice}
            onChange={(e) => {
              setChoice(Number(e.target.value));
              setConfirming(false);
            }}
            disabled={busy}
          >
            {targets.map((candidate, index) => (
              <option key={`${candidate.folder}:${index}`} value={index}>
                {label(candidate)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {idNamed ? null : (
        <FormField label="Name" hint="The file's name there.">
          {(field) => <Input {...field} name="name" autoComplete="off" maxLength={200} value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy} />}
        </FormField>
      )}
      {toEncrypted && target && recipients[target.vault]?.ok === false ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="That vault has no one to encrypt to">
            {(recipients[target.vault] as { message: string }).message}
          </Alert>
        </div>
      ) : null}
      {toEncrypted && target && mine !== null && recipients[target.vault]?.ok === true && !(recipients[target.vault] as { text: string }).text.includes(mine) ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading="Your key is not among that vault's recipients">
            The file would be encrypted to the recipients in that vault&apos;s recipients file, which does not list your key: you could not open it afterwards.
          </Alert>
        </div>
      ) : null}
      {confirming ? (
        <div className={styles.notice}>
          <Alert variant="warning" heading={sourceEncrypted && !toEncrypted ? "This decrypts the file" : toEncrypted ? "The plain text stays in the history" : "Move this file?"}>
            {sourceEncrypted && !toEncrypted
              ? "The file is decrypted in your browser and committed as plain text. Everyone who can read the repository will be able to read it, and the encrypted copy stays in its history."
              : sourceEncrypted
                ? "The file is decrypted here and encrypted again to the other vault's recipients. People who can open one vault but not the other lose or gain access to it."
                : "The file is encrypted here, to that vault's recipients, and its plain text is taken out of this commit. The repository's earlier commits still hold the plain text; removing it from them is a job for git."}
          </Alert>
        </div>
      ) : null}
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error" heading="Nothing was moved">
            {error}
          </Alert>
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" size="sm" loading={busy} disabled={!target || newName.trim() === "" || (toEncrypted && target !== undefined && recipients[target.vault]?.ok !== true)} variant={confirming ? "destructive" : "primary"}>
          {confirming ? (sourceEncrypted && !toEncrypted ? "Yes, decrypt and move" : "Yes, move it") : "Move"}
        </Button>{" "}
        <Button type="button" variant="secondary" size="sm" onClick={() => (setOpen(false), setConfirming(false), setError(null))} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
