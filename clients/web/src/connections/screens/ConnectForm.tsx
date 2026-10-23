"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Alert, Button, FormField, Input } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

/**
 * Connect a repository by its address and a fine-grained access token. The token goes to this
 * server in one request and is checked there; it is not kept in the page after, and it is never
 * shown again.
 */
export function ConnectForm() {
  const router = useRouter();
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWarnings([]);
    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository, token }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string }; warnings?: string[] } | null;
      if (!response.ok) {
        setError(body?.error?.message ?? "The repository was not connected. Try again.");
        return;
      }
      setRepository("");
      setToken("");
      setWarnings(body?.warnings ?? []);
      router.refresh();
    } catch {
      setError("Could not reach this server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="connect-title">
      <h2 id="connect-title">Connect a repository</h2>
      <p>
        On GitHub, create a <strong>fine-grained personal access token</strong> (Settings, Developer settings, Personal access tokens). Give it access to <em>only this repository</em>, with the
        repository permission <strong>Contents: Read and write</strong>. Fjord checks that it works before keeping it, and keeps it encrypted.
      </p>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      {warnings.map((warning) => (
        <div key={warning} className={styles.notice}>
          <Alert variant="warning">{warning}</Alert>
        </div>
      ))}
      <form className={styles.form} onSubmit={onSubmit} style={{ marginTop: 0 }}>
        <FormField label="Repository" hint="Its address, or owner/name." required>
          {(field) => <Input {...field} name="repository" placeholder="https://github.com/you/notes" autoComplete="off" value={repository} onChange={(e) => setRepository(e.target.value)} disabled={busy} />}
        </FormField>
        <FormField label="Access token" required>
          {(field) => <Input {...field} type="password" name="token" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} disabled={busy} />}
        </FormField>
        <div className={styles.actions}>
          <Button type="submit" loading={busy}>
            Connect
          </Button>
        </div>
      </form>
    </section>
  );
}
