import { SignedInShell } from '../../auth/screens/SignedInShell';
import type { ReactNode } from 'react';
import { SetupOffer } from '../../browse/screens/SetupOffer';
import type { Assessment } from '../../browse/setup';
import type { Outcome } from '../../browse/server';
import { repositoryHref } from '../../browse/links';
import { deletedAddress } from '../../browse/addresses';
import { Alert, Badge, Card } from '@sovereignfs/ui';
import { SetIcon } from '../../ui/icons';
import type { ConnectionInfo } from '../service';
import { defaultVault } from '../../browse/default-vault';
import { connectionLabel } from '../label';
import { DefaultVaultSetting } from './DefaultVaultSetting';
import { MakeDefaultButton } from './MakeDefaultButton';
import { RepositorySettings } from './RepositorySettings';
import { LocalSettings } from '../../local/screens/LocalSettings';
import header from './RepositoryHeader.module.css';
import { ChangeKind } from '../../kinds/screens/ChangeKind';
import styles from '../../auth/screens/screens.module.css';

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
  crumbs,
}: {
  user: { name: string; email: string };
  connections: ConnectionInfo[];
  current: ConnectionInfo;
  outcome: Outcome;
  /** What to show in place of the vault list: a folder or a file of a vault (`/repo/<id>/<path>`). */
  content?: ReactNode;
  /** Where the folder or file shown is, as a path: drawn between the repository's name and the card that holds `content`, not in it. */
  crumbs?: ReactNode;
  /** What the repository opens on: its kind's entry view (`entryFor`), which for a drive is its vaults and the top of the one it opens on; only without `content`. */
  landing?: ReactNode;
  /**
   * The kind the repository is, when it is not a drive, and whether it is being shown as files: a link between the two is offered,
   * since every kind can be shown as a drive (spec §3.1).
   */
  kind?:
    | {
        label: string;
        asFiles: boolean;
        /** Where the files of its one vault are, which is what "Show files" is. */ filesHref?: string;
      }
    | undefined;
  /** For a repository that is not a Fjord repository: the offer to set it up, or why there is none (ROADMAP 1a.10). */
  setup?: Assessment | undefined;
}) {
  const label = connectionLabel(current);
  return (
    <SignedInShell
      user={user}
      connections={connections.map((connection) =>
        connection.id === current.id && outcome.ok && outcome.read.manifest?.ok
          ? { ...connection, repoKind: outcome.read.manifest.kind }
          : connection,
      )}
      place={{ repository: current.publicId }}
    >
      <div className={styles.workspace}>
        <div className={header.head}>
          <div className={header.row}>
            <h1 className={styles.title}>{label}</h1>
            <div className={header.buttons}>
              <RepositorySettings>
                <section aria-label="Default">
                  <h2>Default</h2>
                  {current.isDefault ? (
                    <p>This is your default repository: it is where signing in lands.</p>
                  ) : (
                    <MakeDefaultButton id={current.id} label={label} />
                  )}
                </section>
                {current.provider === 'local' ? <LocalSettings current={current} /> : null}
                {outcome.ok && outcome.read.manifest?.ok ? (
                  <section aria-label="Kind">
                    <h2>Kind</h2>
                    <ChangeKind
                      connectionId={current.id}
                      kind={outcome.read.manifest.declaredKind ?? 'drive'}
                      engine={outcome.read.manifest.ssgEngine}
                      serverSide={current.provider === 'local'}
                    />
                  </section>
                ) : null}
                {outcome.ok && outcome.read.discovery.vaults.length > 1 ? (
                  <section aria-label="Default vault">
                    <h2>Default vault</h2>
                    <p>
                      The vault this repository opens on, where signing in lands when it is your
                      default repository.
                    </p>
                    <DefaultVaultSetting
                      connectionId={current.id}
                      vaults={outcome.read.discovery.vaults.map((vault) => ({
                        directory: vault.directory,
                        label: vault.name ?? vault.directory,
                      }))}
                      current={defaultVault(
                        outcome.read.discovery,
                        outcome.read.manifest,
                        current.defaultVault,
                      )}
                    />
                  </section>
                ) : null}
                <section aria-label="Repositories">
                  <h2>Repositories</h2>
                  <p>
                    <a href="/repositories">Connect or disconnect repositories</a>
                  </p>
                </section>
              </RepositorySettings>
              <a
                className={header.iconButton}
                href={deletedAddress(current.address)}
                title="Recently deleted"
                aria-label="Recently deleted"
              >
                <SetIcon name="archive-x" size={20} />
              </a>
            </div>
          </div>
          <p className={styles.lead}>
            {current.provider === 'local' ? 'On this server' : <>Branch {current.branch}</>}
            {current.isDefault ? (
              <>
                {' '}
                <Badge>Default</Badge>
              </>
            ) : null}
          </p>
        </div>
        {crumbs ? <div className={header.crumbs}>{crumbs}</div> : null}
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
                    <a href={repositoryHref(current.address)}>Show as {kind.label.toLowerCase()}</a>
                  ) : (
                    <a href={kind.filesHref ?? `${repositoryHref(current.address)}?view=files`}>
                      Show files
                    </a>
                  )}
                </p>
              ) : null}
              {landing}
            </>
          ) : (
            <Alert variant="error" heading="This repository cannot be shown right now">
              {outcome.problem.message}
            </Alert>
          )}
        </Card>
      </div>
    </SignedInShell>
  );
}
