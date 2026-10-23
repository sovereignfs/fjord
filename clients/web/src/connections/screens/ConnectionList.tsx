"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "../../ui";
import styles from "../../auth/screens/screens.module.css";

export interface ConnectionRow {
  id: number;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
}

/** The repositories this account has connected, each with a way to disconnect it. */
export function ConnectionList({ connections }: { connections: ConnectionRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onDisconnect(connection: ConnectionRow) {
    const label = `${connection.owner}/${connection.name}`;
    if (!window.confirm(`Disconnect ${label}? Fjord will forget its access token. Nothing in the repository changes.`)) return;
    setError(null);
    const response = await fetch(`/api/connections/${connection.id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      setError(`${label} was not disconnected. Try again.`);
      return;
    }
    router.refresh();
  }

  if (connections.length === 0) return <p>No repositories are connected yet.</p>;
  return (
    <>
      {error ? (
        <div className={styles.notice}>
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}
      <ul className={styles.list} aria-label="Connected repositories">
        {connections.map((connection) => (
          <li key={connection.id} className={styles.item}>
            <span>
              {connection.owner}/{connection.name}
              <span className={styles.itemMeta}>
                {" "}
                · branch {connection.branch} · connected {new Date(connection.createdAt).toLocaleDateString()}
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => onDisconnect(connection)}>
              Disconnect
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
