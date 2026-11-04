import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../../src/auth/server";
import { deletedAddress } from "../../../src/browse/addresses";
import { isLegacyId, isPublicId } from "../../../src/connections/public-id";
import { connectionService } from "../../../src/connections/server";
import { encryptionKeyring } from "../../../src/crypto/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recently deleted" };

/**
 * What was deleted was at `/deleted/<repo>`: it is `/repo/<repo>/deleted` (workstream 0003's follow-ups), and this address is sent there, by the number a repository used
 * to be called as well as by its name. Someone else's repository, or one that is not there, is a 404.
 */
export default async function RecentlyDeletedPage({ params }: { params: Promise<{ connection: string }> }) {
  const { user } = await requireSession();
  const { connection } = await params;
  if (encryptionKeyring() === undefined || !(isLegacyId(connection) || isPublicId(connection))) notFound();
  const service = await connectionService();
  const known = isLegacyId(connection) ? await service.get(user.id, Number(connection)) : await service.getByPublicId(user.id, connection);
  if (!known) notFound();
  redirect(deletedAddress(known.address));
}
