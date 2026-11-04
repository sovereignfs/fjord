import { SignedInShell } from "../../auth/screens/SignedInShell";
import type { ReactNode } from "react";
import { SetupOffer } from "../../browse/screens/SetupOffer";
import type { Assessment } from "../../browse/setup";
import type { Outcome } from "../../browse/server";
import { repositoryHref } from "../../browse/links";
import { Alert, Badge, Card } from "../../ui";
import type { ConnectionInfo } from "../service";
import { MakeDefaultButton } from "./MakeDefaultButton";
import { ChangeKind } from "../../kinds/screens/ChangeKind";
import styles from "../../auth/screens/screens.module.css";

/**
 * A repository's page: which one it is, its vaults and what is in them (ROADMAP 1a.11). `/` shows the default repository's, and `/repo/<id>` any of the
 * account's own. The rail of the shell has an icon for each, to move between them. What the git host or the setup got wrong is said, not thrown.
 */
export function RepositoryView({
  user,
  connections,
  current,
  outcome,
  content,
  landing,
  setup,
  kind,
}: {
  user: { name: string; email: string };
  connections: ConnectionInfo[];
  current: ConnectionInfo;
  outcome: Outcome;
  /** What to show in place of the vault list: a folder or a file of a vault (`/repo/<id>/<path>`). */
  content?: ReactNode;
  /** What the repository opens on: its kind's entry view (`entryFor`), which for a drive is its vaults and the top of the one it opens on; only without `content`. */
  landing?: ReactNode;
  /**
   * The kind the repository is, when it is not a drive, and whether it is being shown as files: a link between the two is offered,
   * since every kind can be shown as a drive (spec §3.1).
   */
  kind?: { label: string; asFiles: boolean; /** Where the files of its one vault are, which is what "Show files" is. */ filesHref?: string } | undefined;
  /** For a repository that is not a Fjord repository: the offer to set it up, or why there is none (ROADMAP 1a.10). */
  setup?: Assessment | undefined;
}) {
  const label = `${current.owner}/${current.name}`;
  return (
    <SignedInShell user={user} connections={connections.map((connection) => (connection.id === current.id && outcome.ok && outcome.read.manifest?.ok ? { ...connection, repoKind: outcome.read.manifest.kind } : connection))} place={{ repository: current.publicId }}>
      <div className={styles.workspace}>
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
              {kind ? (
                <p className={styles.lead}>
                  {kind.asFiles ? (
                    <a href={repositoryHref(current.publicId)}>Show as {kind.label.toLowerCase()}</a>
                  ) : (
                    <a href={kind.filesHref ?? `${repositoryHref(current.publicId)}?view=files`}>Show files</a>
                  )}
                </p>
              ) : null}
              {landing}
              {landing && outcome.read.manifest?.ok ? <ChangeKind connectionId={current.id} kind={outcome.read.manifest.declaredKind ?? "drive"} engine={outcome.read.manifest.ssgEngine} /> : null}
            </>
          ) : (
            <Alert variant="error" heading="This repository cannot be shown right now">
              {outcome.problem.message}
            </Alert>
          )}
          {current.isDefault ? null : <MakeDefaultButton id={current.id} label={label} />}
        </Card>
        <p>
          <a href={`/deleted/${current.publicId}`}>Recently deleted</a>
          {" · "}
          <a href="/repositories">Connect or disconnect repositories</a>
        </p>
      </div>
    </SignedInShell>
  );
}
