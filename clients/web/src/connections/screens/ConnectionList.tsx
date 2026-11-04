"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button } from "../../ui";
import { connectionLabel } from "../label";
import { MakeDefaultButton } from "./MakeDefaultButton";
import styles from "../../auth/screens/screens.module.css";

export interface ConnectionRow {
  id: number;
  /** What it is called in an address. */
  publicId: string;
  /** Where its addresses begin: `<kind>/<public id>`. */
  address: string;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
  isDefault: boolean;
  /** `app`: through the GitHub App. Absent or `pat`: through an access token. `local`: kept on this server. */
  kind?: "pat" | "app" | "local";
  provider?: "github" | "local";
}

/** The repositories this account has connected, each with a way to disconnect it. */
export function ConnectionList({ connections }: { connections: ConnectionRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onDisconnect(connection: ConnectionRow) {
    const label = connectionLabel({ provider: connection.provider ?? "github", owner: connection.owner, name: connection.name });
    const question =
      connection.kind === "local"
        ? `Delete ${label}? It is kept only on this server, so all its files are deleted with it and cannot be got back. To keep them, connect it to a git repository instead.`
        : `Disconnect ${label}? ${connection.kind === "app" ? "Fjord will stop using the GitHub App for it; the App stays installed on GitHub until you remove it there." : "Fjord will forget its access token."} Nothing in the repository changes.`;
    if (!window.confirm(question)) return;
    setError(null);
    const response = await fetch(`/api/connections/${connection.id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      setError(`${label} was not ${connection.kind === "local" ? "deleted" : "disconnected"}. Try again.`);
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
              <a href={`/${connection.address}`}>{connectionLabel({ provider: connection.provider ?? "github", owner: connection.owner, name: connection.name })}</a>{" "}
              {connection.isDefault ? <Badge>Default</Badge> : null}
              <span className={styles.itemMeta}>
                {" "}
                · {connection.kind === "local" ? "on this server" : `branch ${connection.branch}`} · {connection.kind === "local" ? "created" : "connected"} {new Date(connection.createdAt).toLocaleDateString()}
              </span>
            </span>
            <span className={styles.actions}>
              {connection.isDefault ? null : <MakeDefaultButton id={connection.id} label={connectionLabel({ provider: connection.provider ?? "github", owner: connection.owner, name: connection.name })} />}
              <Button variant="ghost" size="sm" onClick={() => onDisconnect(connection)}>
                {connection.kind === "local" ? "Delete" : "Disconnect"}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
