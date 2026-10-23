import { notFound } from "next/navigation";
import { localAuthConfig, requireSession } from "../../../src/auth/server";
import { RepositoryView } from "../../../src/connections/screens/RepositoryView";
import { connectionService } from "../../../src/connections/server";
import { encryptionKeyring } from "../../../src/crypto/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/**
 * One of the account's own repositories (`/p/<connection>`; the path inside it comes with the file
 * browser, ROADMAP 1a.11). Someone else's, or one that is not there, is a 404 and nothing more.
 */
export default async function RepositoryPage({ params }: { params: Promise<{ connection: string }> }) {
  const { user } = await requireSession();
  const { connection } = await params;
  if (!/^[1-9][0-9]{0,15}$/.test(connection) || encryptionKeyring() === undefined) notFound();
  const connections = await (await connectionService()).list(user.id);
  const current = connections.find((c) => c.id === Number(connection));
  if (!current) notFound();
  return <RepositoryView user={user} connections={connections} current={current} security={localAuthConfig() !== undefined} />;
}
