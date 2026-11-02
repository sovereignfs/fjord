import { connectionService } from "../../connections/server";
import type { ConnectionInfo } from "../../connections/service";
import { isProviderError } from "../../providers/errors";
import type { BuildStatus as Status } from "../../providers/types";
import { BuildStatusView } from "./BuildStatusView";

/**
 * The build of the site's head commit, read from the git host through the connection's own provider (ROADMAP 3c.3). Nothing here is the
 * host's to be trusted with the page: the provider hands back only `http(s)` addresses, and a failure to read is never a failure of the page.
 */
export async function BuildStatus({ accountId, connection, commit }: { accountId: string; connection: ConnectionInfo; commit: string }) {
  let status: Status | undefined;
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return null;
    status = await used.provider.getBuildStatus({ owner: connection.owner, name: connection.name }, commit);
  } catch (error) {
    if (isProviderError(error, "forbidden")) return <BuildStatusView unreadable />;
    // The host could not be asked just now: the site's posts are what this page is for, and are shown without it.
    return null;
  }
  return <BuildStatusView status={status} />;
}
