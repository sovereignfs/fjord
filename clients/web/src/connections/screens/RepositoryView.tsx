import { AccountHeader } from "../../auth/screens/AccountHeader";
import type { ReactNode } from "react";
import { chosenVault } from "../../browse/screens/Landing";
import { AddVault } from "../../browse/screens/AddVault";
import { SetupOffer } from "../../browse/screens/SetupOffer";
import type { Assessment } from "../../browse/setup";
import { VaultList } from "../../browse/screens/VaultList";
import type { Outcome } from "../../browse/server";
import { Alert, Badge, Card } from "../../ui";
import type { ConnectionInfo } from "../service";
import { MakeDefaultButton } from "./MakeDefaultButton";
import styles from "../../auth/screens/screens.module.css";

/**
 * A repository's page: which one it is, its vaults and what is in them (ROADMAP 1a.11), and a way to move
 * between the account's repositories. `/` shows the default repository's, and `/repo/<id>` any of the
 * account's own. What the git host or the setup got wrong is said, not thrown.
 */
export function RepositoryView({
  user,
  connections,
  current,
  outcome,
  content,
  landing,
  setup,
  security,
}: {
  user: { name: string; email: string };
  connections: ConnectionInfo[];
  current: ConnectionInfo;
  outcome: Outcome;
  /** What to show in place of the vault list: a folder or a file of a vault (`/repo/<id>/<path>`). */
  content?: ReactNode;
  /** The top of the vault the repository opens on, under the list of vaults (`<Landing>`); only without `content`. */
  landing?: ReactNode;
  /** For a repository that is not a Fjord repository: the offer to set it up, or why there is none (ROADMAP 1a.10). */
  setup?: Assessment | undefined;
  security: boolean;
}) {
  const label = `${current.owner}/${current.name}`;
  return (
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={security} />
      <div className={styles.account}>
        <h1 className={styles.title}>{label}</h1>
        <p className={styles.lead}>
          Branch {current.branch}
          {current.isDefault ? (
            <>
              {" "}
              <Badge>Default</Badge>
            </>
          ) : null}
        </p>
        <Card as="article" padding="lg">
          {content ? (
            content
          ) : outcome.ok && setup?.offer ? (
            <SetupOffer connectionId={current.id} preview={setup.preview} />
          ) : outcome.ok ? (
            <>
              {setup && !setup.offer ? (
                <div className={styles.notice}>
                  <Alert variant="warning" heading="This repository cannot be set up from here">
                    {setup.refusal.message}
                  </Alert>
                </div>
              ) : null}
              <VaultList read={outcome.read} connectionId={current.id} opensOn={chosenVault(current, outcome)} />
              {outcome.read.manifest?.ok ? <AddVault connectionId={current.id} existing={outcome.read.discovery.vaults.map((vault) => vault.directory)} /> : null}
              {landing}
            </>
          ) : (
            <Alert variant="error" heading="This repository cannot be shown right now">
              {outcome.problem.message}
            </Alert>
          )}
          {current.isDefault ? null : <MakeDefaultButton id={current.id} label={label} />}
        </Card>
        {connections.length > 1 ? (
          <Card as="div" padding="lg">
            <h2 className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
              Your repositories
            </h2>
            <ul className={styles.list} aria-label="Your repositories">
              {connections.map((connection) => (
                <li key={connection.id} className={styles.item}>
                  <a href={`/repo/${connection.id}`} aria-current={connection.id === current.id ? "page" : undefined}>
                    {connection.owner}/{connection.name}
                  </a>
                  {connection.isDefault ? <Badge>Default</Badge> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <p>
          <a href={`/deleted/${current.id}`}>Recently deleted</a>
          {" · "}
          <a href="/repositories">Connect or disconnect repositories</a>
        </p>
      </div>
    </main>
  );
}
