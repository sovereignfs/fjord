import { getDatabase } from '../db/boot';
import { ShareService } from './shares';

/** How many documents are shared with this account: whether the rail shows *Shared with you*. Kept apart from `server.ts`, which the shell must not pull in with everything it reads. */
export async function sharedCountFor(accountId: string): Promise<number> {
  return new ShareService(await getDatabase()).countFor(accountId);
}
