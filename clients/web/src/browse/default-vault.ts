import type { Discovery, RepositoryManifest } from "../format/types";

/**
 * Which vault opens first for a connected repository (DESIGN.md §7): the one the account has chosen, and until it
 * chooses, **the first vault `fjord.json` lists**. The filesystem is authoritative (spec §2.1), so a vault `fjord.json`
 * lists that is not there is skipped, a vault that is there and not listed can still be chosen, and with no usable
 * `fjord.json` it is the first vault found. A choice that names a vault that has since gone is ignored, not an error:
 * the next one stands in until the account chooses again.
 *
 * Which vaults exist, and `fjord.json`'s order, are the format module's answers; this only picks among them.
 */
export function defaultVault(discovery: Discovery, manifest: RepositoryManifest | null, chosen: string | null): string | undefined {
  const existing = discovery.vaults.map((vault) => vault.directory);
  if (chosen !== null && existing.includes(chosen)) return chosen;

  if (manifest?.ok && manifest.vaults) {
    for (const entry of manifest.vaults) {
      if (entry.path !== null && existing.includes(entry.path)) return entry.path;
    }
  }
  return existing[0];
}
