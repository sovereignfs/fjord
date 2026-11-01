"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Alert, Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";
import { loadModule } from "../keys/module";
import { MIN_PASSPHRASE_LENGTH } from "../keys/store";
import { type SealedShareView, createSealed, listSealed, revokeSealed } from "./client";
import { keyFragment, sealShare } from "./seal";
import type { SealedMode } from "./service";

/**
 * Share an encrypted file by a sealed link (ROADMAP 2c.1, DESIGN.md §12). The page has the file's text (it decrypted it), so **this browser** makes the copy: sealed to a key
 * that is put in the link's `#fragment` (no request carries it, and it is shown once and kept nowhere), or to a password the viewer types. The server keeps the sealed copy
 * and serves it to the link; it cannot read it. It is a **snapshot**: to share a newer version, make a new link and revoke the old, which deletes its copy. A link gives
 * read access only; comments on a sealed copy are not here.
 */
export function SealedSharePanel({ connectionId, path, name, getText }: { connectionId: number; path: string; name: string; getText: () => string }) {
  const [shares, setShares] = useState<SealedShareView[] | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SealedMode>("key");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ link: string; mode: SealedMode } | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => setShares(await listSealed(connectionId, path)), [connectionId, path]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function make(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMade(null);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so that "Making…" shows before a slow password is hashed
    try {
      const sealed = sealShare(await loadModule(), mode === "key" ? { name, text: getText(), mode: "key" } : { name, text: getText(), mode: "password", password });
      const created = await createSealed(connectionId, { path, mode, ciphertext: sealed.ciphertext });
      if (!created.ok) {
        setError(created.message);
        return;
      }
      // The key is added after the token, in the fragment, in this page only: it was never in a request.
      setMade({ link: `${window.location.origin}/s/${created.token}${sealed.mode === "key" ? keyFragment(sealed.key) : ""}`, mode });
      setPassword("");
      setOpen(false);
      await refresh();
    } catch {
      setError("The copy could not be sealed here, so nothing was shared.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    setError(null);
    if (await revokeSealed(connectionId, id)) {
      setMade(null);
      await refresh();
    } else {
      setError("Could not revoke that link just now. Try again.");
    }
  }

  return (
    <section aria-labelledby="sealed-title" data-testid="sealed-shares">
      <h3 id="sealed-title" style={{ fontSize: "var(--sv-font-size-md)" }}>
        Sealed links
      </h3>
      <p className={styles.itemMeta}>A link to a copy of this file as it is now, encrypted in this browser. The server keeps the copy and cannot read it. Anyone with the link (and the password, if it has one) can read it.</p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {made ? (
        <div className={styles.notice} data-testid="sealed-made">
          <Alert variant="success" heading="Link made">
            <p>
              {made.mode === "key" ? "The key to the copy is in this link, after the #. It is not kept anywhere, here or on the server, so this is the only time it is shown: keep the link." : "The viewer needs the password you chose, which is not in the link and is not kept: tell them separately."}
            </p>
            <p>
              <code data-testid="sealed-link" style={{ overflowWrap: "anywhere" }}>
                {made.link}
              </code>
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(made.link).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </Alert>
        </div>
      ) : null}
      {shares && shares.length > 0 ? (
        <ul className={styles.list} aria-label="Sealed links">
          {shares.map((share) => (
            <li key={share.id} className={styles.item}>
              <span>
                {share.mode === "key" ? "Key in the link" : "Password"}
                <span className={styles.itemMeta}> · made {new Date(share.createdAt).toLocaleString()}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void revoke(share.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <form className={styles.form} aria-label="Make a sealed link" onSubmit={make} style={{ marginTop: 0 }}>
          <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
            <label>
              <input type="radio" name="mode" checked={mode === "key"} onChange={() => setMode("key")} /> The key is in the link
            </label>
            <br />
            <label>
              <input type="radio" name="mode" checked={mode === "password"} onChange={() => setMode("password")} /> A password opens it
            </label>
          </fieldset>
          {mode === "password" ? (
            <FormField label="Password" hint={`At least ${MIN_PASSPHRASE_LENGTH} characters. Anyone who gets the link can try passwords, slowly, so make it a good one.`} required>
              {(field) => <Input {...field} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />}
            </FormField>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" size="sm" loading={busy} disabled={mode === "password" && password.length < MIN_PASSPHRASE_LENGTH}>
              Make link
            </Button>{" "}
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOpen(true);
            setCopied(false);
          }}
        >
          Make a sealed link
        </Button>
      )}
    </section>
  );
}
