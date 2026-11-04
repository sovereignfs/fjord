import { requireSession } from "../../src/auth/server";
import { encryptionKeyring } from "../../src/crypto/server";
import { SharedWithYou } from "../../src/sharing/screens/SharedWithYou";
import { sharedWithFor } from "../../src/sharing/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Shared with you" };

/** What other accounts on this instance have shared with the signed-in person: a listing, each document opened at `/d/<id>`. */
export default async function SharedPage() {
  const { user } = await requireSession();
  const { documents, unreadable } = encryptionKeyring() === undefined ? { documents: [], unreadable: 0 } : await sharedWithFor(user.id);
  return <SharedWithYou user={user} documents={documents} unreadable={unreadable} />;
}
