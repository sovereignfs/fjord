import { notFound } from "next/navigation";
import { localAuthConfig, requireSession } from "../../../src/auth/server";
import { AccountHeader } from "../../../src/auth/screens/AccountHeader";
import styles from "../../../src/auth/screens/screens.module.css";
import { RecentlyDeleted } from "../../../src/browse/screens/RecentlyDeleted";
import { connectionService } from "../../../src/connections/server";
import { encryptionKeyring } from "../../../src/crypto/server";
import { getDatabase } from "../../../src/db/boot";
import { restoreWindowMs } from "../../../src/files/config";
import { DeletionService } from "../../../src/files/deletions";
import { Card } from "../../../src/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recently deleted" };

const DAY = 24 * 60 * 60 * 1000;

/** `2026-10-22 14:30 UTC`: the same text on the server and in the browser. */
const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * What was deleted from one of the account's repositories through this app, within the restore window (DESIGN.md §8,
 * ROADMAP 1b.12). Someone else's repository, or one that is not there, is a 404.
 */
export default async function RecentlyDeletedPage({ params }: { params: Promise<{ connection: string }> }) {
  const { user } = await requireSession();
  const { connection } = await params;
  if (!/^[1-9][0-9]{0,15}$/.test(connection) || encryptionKeyring() === undefined) notFound();
  const current = await (await connectionService()).get(user.id, Number(connection));
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
    <main className={styles.page}>
      <AccountHeader name={user.name} email={user.email} security={localAuthConfig() !== undefined} />
      <div className={styles.account}>
        <h1 className={styles.title}>Recently deleted</h1>
        <p className={styles.lead}>
          {current.owner}/{current.name} · <a href={`/repo/${current.id}`}>Back to the repository</a>
        </p>
        <Card as="article" padding="lg">
          <RecentlyDeleted connectionId={current.id} groups={groups} days={Math.round(window / DAY)} />
        </Card>
      </div>
    </main>
  );
}
