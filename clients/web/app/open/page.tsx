import { redirect } from "next/navigation";
import { requireSession } from "../../src/auth/server";
import { vaultAddress } from "../../src/browse/addresses";
import { defaultVault } from "../../src/browse/default-vault";
import { repositoryHref } from "../../src/browse/links";
import { readConnection } from "../../src/browse/server";
import { connectionService } from "../../src/connections/server";
import { encryptionKeyring } from "../../src/crypto/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Opening" };

/**
 * Where signing in lands, and what *Open* means: the default vault of the account's default repository, which is the first it connected until it chooses another,
 * and in it the vault that opens first (`/repo/<repo>/v/<vault>`). A journal or a site has one vault that is never shown, so it opens on the repository. With
 * no repository yet, or one that cannot be read or has no vault with an id, the repository's own page, which says why; with none connected, the home page.
 */
export default async function OpenPage() {
  const { user } = await requireSession();
  const connections = encryptionKeyring() !== undefined ? await (await connectionService()).list(user.id) : [];
  const current = connections.find((connection) => connection.isDefault);
  if (!current) redirect("/");
  const outcome = await readConnection(user.id, current);
  if (outcome.ok && (!outcome.read.manifest?.ok || outcome.read.manifest.kind === "drive")) {
    const directory = defaultVault(outcome.read.discovery, outcome.read.manifest, current.defaultVault);
    const vault = outcome.read.discovery.vaults.find((candidate) => candidate.directory === directory);
    if (vault?.id) redirect(vaultAddress(current.address, vault.id));
  }
  redirect(repositoryHref(current.address));
}
