"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button } from "../../ui";
import { MakeDefaultButton } from "./MakeDefaultButton";
import styles from "../../auth/screens/screens.module.css";

export interface ConnectionRow {
  id: number;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
  isDefault: boolean;
  /** `app`: through the GitHub App. Absent or `pat`: through an access token. */
  kind?: "pat" | "app";
}

/** The repositories this account has connected, each with a way to disconnect it. */
export function ConnectionList({ connections }: { connections: ConnectionRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onDisconnect(connection: ConnectionRow) {
    const label = `${connection.owner}/${connection.name}`;
    if (!window.confirm(`Disconnect ${label}? ${connection.kind === "app" ? "Fjord will stop using the GitHub App for it; the App stays installed on GitHub until you remove it there." : "Fjord will forget its access token."} Nothing in the repository changes.`)) return;
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
              <a href={`/repo/${connection.id}`}>
                {connection.owner}/{connection.name}
              </a>{" "}
              {connection.isDefault ? <Badge>Default</Badge> : null}
              <span className={styles.itemMeta}>
                {" "}
                · branch {connection.branch} · connected {new Date(connection.createdAt).toLocaleDateString()}
              </span>
            </span>
            <span className={styles.actions}>
              {connection.isDefault ? null : <MakeDefaultButton id={connection.id} label={`${connection.owner}/${connection.name}`} />}
              <Button variant="ghost" size="sm" onClick={() => onDisconnect(connection)}>
                Disconnect
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
