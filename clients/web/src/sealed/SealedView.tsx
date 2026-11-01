"use client";

import { NoteEditor } from "fjord-editor";
import "fjord-editor/styles.css";
import { type FormEvent, useEffect, useState } from "react";
import { Alert, Button, FormField, Input } from "../ui";
import styles from "../auth/screens/screens.module.css";
import { loadModule } from "../keys/module";
import { fetchSealed } from "./client";
import { keyFromFragment, openShare } from "./seal";
import type { SealedMode } from "./service";

/**
 * A sealed copy, opened by its link (ROADMAP 2c.1). The address's path holds the token that finds the copy; its fragment holds the key, and the browser never sends a
 * fragment, so the server that serves the copy cannot open it. The copy is fetched without credentials, opened here, and shown read-only; nothing decrypted leaves the page.
 * A copy sealed to a password asks for it.
 */
export function SealedView({ token }: { token: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "gone"; message: string }
    | { kind: "password"; ciphertext: string }
    | { kind: "open"; name: string; text: string }
    | { kind: "locked"; message: string }
  >({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const copy = await fetchSealed(token);
      if (!current) return;
      if (!copy.ok) return setState({ kind: "gone", message: copy.message });
      if (copy.mode === "password") return setState({ kind: "password", ciphertext: copy.ciphertext });
      const key = keyFromFragment(window.location.hash);
      if (!key) return setState({ kind: "locked", message: "This link is incomplete: the key that opens the copy is missing from it. Ask for the whole link." });
      const opened = openShare(await loadModule(), { mode: "key", ciphertext: copy.ciphertext, secret: key });
      if (!current) return;
      setState(opened.ok ? { kind: "open", name: opened.name, text: opened.text } : { kind: "locked", message: opened.reason === "wrong_secret" ? "The key in this link does not open the copy: the link is not the whole one, or was changed." : "The copy opened, but is not a shared document." });
    })();
    return () => {
      current = false;
    };
  }, [token]);

  async function onPassword(event: FormEvent) {
    event.preventDefault();
    if (state.kind !== "password") return;
    setBusy(true);
    setError(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const opened = openShare(await loadModule(), { mode: "password" as SealedMode, ciphertext: state.ciphertext, secret: password });
      if (opened.ok) setState({ kind: "open", name: opened.name, text: opened.text });
      else setError(opened.reason === "wrong_secret" ? "That password does not open it." : "The copy opened, but is not a shared document.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return <p role="status">Opening…</p>;
  if (state.kind === "gone" || state.kind === "locked") {
    return (
      <Alert variant="error" heading="This cannot be opened">
        {state.message}
      </Alert>
    );
  }
  if (state.kind === "password") {
    return (
      <form className={styles.form} onSubmit={onPassword} style={{ marginTop: 0 }}>
        <p className={styles.itemMeta}>This document is shared with a password. It is opened in your browser; the password is not sent anywhere.</p>
        {error ? (
          <div className={styles.notice}>
            <Alert variant="error">{error}</Alert>
          </div>
        ) : null}
        <FormField label="Password" required>
          {(field) => <Input {...field} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" loading={busy}>
            Open
          </Button>
        </div>
      </form>
    );
  }
  return (
    <section aria-labelledby="sealed-doc">
      <h2 id="sealed-doc" className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
        {state.name}
      </h2>
      <p className={styles.itemMeta}>Shared with you as a sealed copy, read only. It was opened in this browser; the server that sent it cannot read it.</p>
      <NoteEditor aria-label={state.name} value={state.text} readOnly />
    </section>
  );
}
