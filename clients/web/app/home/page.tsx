import { requireSession } from "../../src/auth/server";
import { FirstRun } from "../../src/connections/screens/FirstRun";
import { RepositoryGrid } from "../../src/connections/screens/RepositoryGrid";
import { connectionService } from "../../src/connections/server";
import { encryptionKeyring } from "../../src/crypto/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

/**
 * What someone signed in sees at `/` (the proxy shows this page there): a tile for each repository they have connected, to open one, and before they
 * have connected one, the prompt to connect their first (ROADMAP 1a.9). It reads nothing from the git host: the tiles are drawn from what is stored.
 */
export default async function HomePage() {
  const { user } = await requireSession();
  const canConnect = encryptionKeyring() !== undefined;
  const connections = canConnect ? await (await connectionService()).list(user.id) : [];
  if (connections.length === 0) return <FirstRun user={user} canConnect={canConnect} />;
  return <RepositoryGrid user={user} connections={connections} />;
}
