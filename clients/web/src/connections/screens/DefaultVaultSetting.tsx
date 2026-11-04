"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Select } from "../../ui";
import styles from "./RepositoryHeader.module.css";

/**
 * The vault a repository opens on, chosen from its vaults (`PUT /api/connections/<id>/vault`): where signing in lands when this repository is the default. On the web it is a quiet setting more
 * than anything (every vault is one click from the repository's page), so it lives here with the other settings, and not as a button on each vault.
 */
export function DefaultVaultSetting({ connectionId, vaults, current }: { connectionId: number; vaults: { directory: string; label: string }[]; current: string | undefined }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(current ?? vaults[0]?.directory ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connections/${connectionId}/vault`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vault: chosen }) });
      if (!response.ok) {
        setError("That vault was not made the one this repository opens on. Try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach this server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.field}>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <label htmlFor="default-vault">Opens on</label>
      <div className={styles.inline}>
        <Select id="default-vault" name="vault" value={chosen} onChange={(event) => setChosen(event.target.value)} disabled={busy}>
          {vaults.map((vault) => (
            <option key={vault.directory} value={vault.directory}>
              {vault.label}
            </option>
          ))}
        </Select>
        <Button variant="secondary" size="sm" onClick={save} loading={busy} disabled={chosen === current}>
          Use this vault
        </Button>
      </div>
    </div>
  );
}
