import { AccountPanel, type AccountQuery } from "../../src/auth/screens/AccountPanel";
import { SignedInShell } from "../../src/auth/screens/SignedInShell";
import { requireSession } from "../../src/auth/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account" };

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/**
 * The account at an address of its own: reached directly, by a bookmark or a refresh, or on the way back from linking Sovereign (`?section=security&linked=1`). From a page of the app, the
 * menu's *Account* is a soft navigation here that is intercepted and shown as a dialog over that page instead (`app/@modal/(.)account`); the content is the same (`AccountPanel`).
 */
export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireSession();
  const query = await searchParams;
  const asked: AccountQuery = { section: one(query.section), tab: one(query.tab), error: one(query.error), linked: one(query.linked), unlinked: one(query.unlinked) };
  return (
    <SignedInShell user={user} place="account">
      <AccountPanel user={user} query={asked} />
    </SignedInShell>
  );
}
