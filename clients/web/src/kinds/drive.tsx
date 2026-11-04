import { AddVault } from "../browse/screens/AddVault";
import { chosenVault } from "../browse/screens/Landing";
import { VaultList } from "../browse/screens/VaultList";
import type { EntryViewProps, KindModule } from "./types";

/**
 * A drive (spec §3.1): any number of vaults, each encrypted or not, and what every repository made before kinds existed is. Its entry view is its vaults as folders, as rows or
 * tiles (the contents of one are one level down, when it is opened: `/open`, where signing in lands, goes into the one the repository opens on), and it is what every other kind
 * can be shown as ("Show files").
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

function DriveEntry({ connection, read }: EntryViewProps) {
  const outcome = { ok: true as const, read };
  const add = read.manifest?.ok ? <AddVault connectionId={connection.id} existing={read.discovery.vaults.map((vault) => vault.directory)} /> : undefined;
  return <VaultList read={read} connectionId={connection.id} repo={connection.publicId} opensOn={chosenVault(connection, outcome)} actions={add} />;
}
