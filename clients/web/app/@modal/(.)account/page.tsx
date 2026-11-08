import { AccountDialog } from '../../../src/auth/screens/AccountDialog';
import { AccountPanel, type AccountQuery } from '../../../src/auth/screens/AccountPanel';
import { requireSession } from '../../../src/auth/server';

export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

/** `/account` opened from another page of the app (the menu's *Account*): the same account, as a dialog over that page. A refresh or a typed address is the page at `app/account`. */
export default async function AccountModal({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireSession();
  const query = await searchParams;
  const asked: AccountQuery = {
    section: one(query.section),
    tab: one(query.tab),
    error: one(query.error),
    linked: one(query.linked),
    unlinked: one(query.unlinked),
  };
  return (
    <AccountDialog>
      <AccountPanel user={user} query={asked} />
    </AccountDialog>
  );
}
