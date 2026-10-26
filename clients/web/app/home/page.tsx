import { localAuthConfig, requireSession } from "../../src/auth/server";
import { FirstRun } from "../../src/connections/screens/FirstRun";
import { Landing } from "../../src/browse/screens/Landing";
import { assessSetupFor, readConnection } from "../../src/browse/server";
import { RepositoryView } from "../../src/connections/screens/RepositoryView";
import { connectionService } from "../../src/connections/server";
import { encryptionKeyring } from "../../src/crypto/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

/**
 * What someone signed in sees at `/` (the proxy shows this page there): the repository they have
 * chosen as their default, which is the first they connected until they choose another, and
 * before they have connected one, the prompt to connect their first (ROADMAP 1a.9).
 */
export default async function HomePage() {
  const { user } = await requireSession();
  const security = localAuthConfig() !== undefined;
  const canConnect = encryptionKeyring() !== undefined;
  const connections = canConnect ? await (await connectionService()).list(user.id) : [];
  const current = connections.find((connection) => connection.isDefault);
  if (!current) return <FirstRun user={user} canConnect={canConnect} security={security} />;
  const outcome = await readConnection(user.id, current);
  const landing = <Landing accountId={user.id} connection={current} outcome={outcome} />;
  return <RepositoryView user={user} connections={connections} current={current} outcome={outcome} landing={landing} setup={await assessSetupFor(user.id, current, outcome)} security={security} />;
}
