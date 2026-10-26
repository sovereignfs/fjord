import { Alert } from "../../ui";
import type { ConnectionInfo } from "../../connections/service";
import { defaultVault } from "../default-vault";
import { type Outcome, locateInRepository } from "../server";
import { FolderView } from "./FolderView";

/**
 * What a repository opens on (DESIGN.md §8): the top of its default vault, under the list of its vaults. The default is
 * the one the account chose, or the first `fjord.json` lists, or the first found (`defaultVault`); a repository with no
 * vault has nothing to open, and the list above says so.
 */
export async function Landing({ accountId, connection, outcome }: { accountId: string; connection: ConnectionInfo; outcome: Outcome }) {
  if (!outcome.ok) return null;
  const directory = chosenVault(connection, outcome);
  if (directory === undefined) return null;

  const found = await locateInRepository(accountId, connection, outcome.read, [directory]);
  if (!found.ok) {
    return (
      <Alert variant="error" heading="This vault cannot be shown right now">
        {found.problem.message}
      </Alert>
    );
  }
  if (found.location.kind === "missing") return null;
  return <FolderView connectionId={connection.id} repository={`${connection.owner}/${connection.name}`} location={found.location} />;
}

/** The directory of the vault a repository opens on, for the page that lists the vaults to mark it. */
export function chosenVault(connection: ConnectionInfo, outcome: Outcome): string | undefined {
  return outcome.ok ? defaultVault(outcome.read.discovery, outcome.read.manifest, connection.defaultVault) : undefined;
}
