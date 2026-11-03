import { redirect } from "next/navigation";
import { requireSession } from "../../src/auth/server";
import { connectionService } from "../../src/connections/server";
import { encryptionKeyring } from "../../src/crypto/server";
import { repositoryHref } from "../../src/browse/links";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opening" };

/**
 * Where signing in lands, and what *Open* means: the default repository of the account, which is the first it connected until it chooses another. With none
 * connected yet, the home page, which asks for the first. (Workstream 0003: this becomes the default vault inside it.)
 */
export default async function OpenPage() {
  const { user } = await requireSession();
  const connections = encryptionKeyring() !== undefined ? await (await connectionService()).list(user.id) : [];
  const current = connections.find((connection) => connection.isDefault);
  redirect(current ? repositoryHref(current.id) : "/");
}
