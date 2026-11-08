import { connectionService } from '../../connections/server';
import { formatBytes } from '../limits';
import styles from '../../auth/screens/screens.module.css';

/** How much of an account's allowance on this server is used (ROADMAP 3i): repositories, files and bytes, each against its limit. */
export async function LocalUsage({ accountId }: { accountId: string }) {
  const usage = await (await connectionService()).localUsage(accountId);
  if (usage.limits.repositories === 0) return null;
  return (
    <p className={styles.itemMeta} style={{ margin: 0 }} aria-label="Space on this server">
      On this server: {usage.repositories} of {usage.limits.repositories}{' '}
      {usage.limits.repositories === 1 ? 'repository' : 'repositories'} · {usage.files} of{' '}
      {usage.limits.files} files · {formatBytes(usage.bytes)} of {formatBytes(usage.limits.bytes)}
    </p>
  );
}
