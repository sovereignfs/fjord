import { AddVault } from "../browse/screens/AddVault";
import { Landing, chosenVault } from "../browse/screens/Landing";
import { VaultList } from "../browse/screens/VaultList";
import type { EntryViewProps, KindModule } from "./types";

/**
 * A drive (spec §3.1): any number of vaults, each encrypted or not, and what every repository made before kinds existed is. Its
 * entry view is the vault list and the top of the vault the repository opens on (DESIGN.md §8), exactly as it was before kinds,
 * and it is what every other kind can be shown as ("Show files").
 */
export const driveKind: KindModule = {
  id: "drive",
  label: "Drive",
  editor: "document",
  writingView: false,
  EntryView: DriveEntry,
  contentModel: { placement: "anywhere", fields: ["title", "tags"] },
  actions: [],
};

function DriveEntry({ accountId, connection, read }: EntryViewProps) {
  const outcome = { ok: true as const, read };
  return (
    <>
      <VaultList read={read} connectionId={connection.id} opensOn={chosenVault(connection, outcome)} />
      {read.manifest?.ok ? <AddVault connectionId={connection.id} existing={read.discovery.vaults.map((vault) => vault.directory)} /> : null}
      <Landing accountId={accountId} connection={connection} outcome={outcome} />
    </>
  );
}
