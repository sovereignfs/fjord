import { AccountDialog } from "../../../src/auth/screens/AccountDialog";
import { AccountPanel, type AccountQuery } from "../../../src/auth/screens/AccountPanel";
import { requireSession } from "../../../src/auth/server";

export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/** `/security` opened from another page of the app: the same panel, as a dialog over that page. A refresh or a typed address is the page at `app/security`. */
export default async function SecurityModal({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireSession();
  const query = await searchParams;
  return (
    <AccountDialog>
      <AccountPanel user={user} query={{ tab: one(query.tab), error: one(query.error), linked: one(query.linked), unlinked: one(query.unlinked) }} />
    </AccountDialog>
  );
}
