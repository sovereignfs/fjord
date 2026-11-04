import { SignedInShell } from "../../auth/screens/SignedInShell";
import { repositoryHref } from "../../browse/links";
import { connectionLabel } from "../label";
import { Badge } from "../../ui";
import { KIND_LABEL, RepositoryKindIcon, Settings2Icon } from "../../ui/icons";
import type { ConnectionInfo } from "../service";
import styles from "./RepositoryGrid.module.css";

/**
 * The home page: a tile for each connected repository, in the look of Sovereign's launcher: its kind's icon, its name, a line of what it is and a chip.
 * Drawn from what is stored (`repoKind` is what the repository was when it was last opened; a tile of one never opened is a drive's until it is).
 */
export function RepositoryGrid({ user, connections }: { user: { name: string; email: string }; connections: ConnectionInfo[] }) {
  return (
    <SignedInShell user={user} connections={connections} place="index">
      <div className={styles.home}>
        <header>
          <h1 className={styles.title}>Fjord</h1>
          <p className={styles.subtitle}>Your private cloud, kept in your own Git repositories.</p>
        </header>
        <div className={styles.sectionRow}>
          <span className={styles.sectionLabel}>REPOSITORIES ({connections.length})</span>
          <a className={styles.manage} href="/repositories" title="Connect or disconnect repositories" aria-label="Connect or disconnect repositories">
            <Settings2Icon size={18} aria-hidden />
          </a>
        </div>
        <ul className={styles.grid} aria-label="Repositories">
          {connections.map((connection) => {
            const kind = connection.repoKind ?? "drive";
            return (
              <li key={connection.id}>
                <a className={styles.tile} href={repositoryHref(connection.address)}>
                  <span className={styles.tileIcon}>
                    <RepositoryKindIcon kind={kind} size={28} />
                  </span>
                  <span className={styles.tileName}>
                    {connectionLabel(connection)}
                  </span>
                  <span className={styles.tileDesc}>{connection.provider === "local" ? `${KIND_LABEL[kind]} on this server` : `${KIND_LABEL[kind]} on branch ${connection.branch}`}</span>
                  <span className={styles.tileSep} aria-hidden="true" />
                  <span className={styles.tileBadgeRow}>
                    <span className={styles.tileBadge}>{kind}</span>
                    {connection.isDefault ? <Badge>Default</Badge> : null}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </SignedInShell>
  );
}
