import { notFound } from 'next/navigation';
import { connectionLabel } from '../../connections/label';
import { requireSession } from '../../auth/server';
import { SignedInShell } from '../../auth/screens/SignedInShell';
import styles from '../../auth/screens/screens.module.css';
import { isPublicId } from '../../connections/public-id';
import { connectionService } from '../../connections/server';
import { encryptionKeyring } from '../../crypto/server';
import { getDatabase } from '../../db/boot';
import { restoreWindowMs } from '../../files/config';
import { DeletionService } from '../../files/deletions';
import { Card } from '../../ui';
import { repositoryHref } from '../links';
import { RecentlyDeleted } from './RecentlyDeleted';
import { momentText } from '../../ui/dates';

const DAY = 24 * 60 * 60 * 1000;

/** `2026-10-22 14:30 UTC`: the same text on the server and in the browser. */
const when = (ms: number) => momentText(ms);

/**
 * What was deleted from one of the account's repositories through this app, within the restore window (DESIGN.md §8, ROADMAP 1b.12), at `/repo/<repo>/deleted`.
 * Someone else's repository, or one that is not there, is a 404.
 */
export async function RecentlyDeletedScreen({ connection }: { connection: string }) {
  const { user } = await requireSession();
  if (!isPublicId(connection) || encryptionKeyring() === undefined) notFound();
  const current = await (await connectionService()).getByPublicId(user.id, connection);
  if (!current) notFound();

  const window = restoreWindowMs();
  const records = await new DeletionService(await getDatabase()).list(current.id, window);
  // The files one deleting commit took are one row: a folder is one thing to put back.
  const groups: { ids: number[]; paths: string[]; when: string }[] = [];
  const byCommit = new Map<string, (typeof groups)[number]>();
  for (const record of records) {
    let group = byCommit.get(record.deletingCommit);
    if (!group) {
      group = { ids: [], paths: [], when: when(record.deletedAt) };
      byCommit.set(record.deletingCommit, group);
      groups.push(group);
    }
    group.ids.push(record.id);
    group.paths.push(record.path);
  }

  return (
    <SignedInShell user={user} place={{ repository: current.publicId }}>
      <div className={styles.workspace}>
        <h1 className={styles.title}>Recently deleted</h1>
        <p className={styles.lead}>
          {connectionLabel(current)} ·{' '}
          <a href={repositoryHref(current.address)}>Back to the repository</a>
        </p>
        <Card as="article" padding="lg">
          <RecentlyDeleted
            connectionId={current.id}
            repo={current.address}
            groups={groups}
            days={Math.round(window / DAY)}
          />
        </Card>
      </div>
    </SignedInShell>
  );
}
