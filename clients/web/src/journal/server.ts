import type { RepositoryRead } from "../browse/repository";
import { connectionService } from "../connections/server";
import type { ConnectionInfo } from "../connections/service";
import { getDatabase } from "../db/boot";
import { fjord } from "../format/wasm";
import { journalVault } from "./entries";
import { JournalIndex } from "./index-store";
import { summaries, tagCounts } from "./timeline";

/**
 * The tags a plaintext journal's entries already carry, as first written and the most used first (ROADMAP 3b.3), for the properties panel
 * to offer while a tag is typed. From what its timeline knows of each entry, so it reads from the host only what it has not read before.
 * None for a repository that is not a plaintext journal, or one that cannot be read just now: suggestions are a help, never a reason to fail.
 */
export async function journalTagsFor(accountId: string, connection: ConnectionInfo, read: RepositoryRead): Promise<string[] | undefined> {
  if (!read.manifest?.ok || read.manifest.kind !== "journal" || read.partial) return undefined;
  const vault = journalVault(read.discovery.vaults);
  if (typeof vault === "string") return undefined;
  try {
    const used = await (await connectionService()).provider(accountId, connection.id);
    if (!used) return undefined;
    const entries = await summaries({ provider: used.provider, ref: { owner: connection.owner, name: connection.name }, format: fjord(), index: new JournalIndex(await getDatabase()) }, connection.id, vault, read.blobs);
    return tagCounts(fjord(), entries).map(({ tag }) => tag);
  } catch {
    return undefined;
  }
}
