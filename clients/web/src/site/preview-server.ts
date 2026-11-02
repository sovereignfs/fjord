import { readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import type { ConnectionInfo } from "../connections/service";
import type { Identity } from "../providers/types";
import { workingCopyService } from "../working/server";
import type { Deps, Listing } from "./preview-http";
import { type PreviewDeps, candidates, previewsOf, startPreview, stopPreview } from "./preview";
import { type SiteRefusal, siteVault } from "./posts";

/**
 * What `preview-http.ts` is handed: the connection's own provider, the person's drafts, and the site's vault, found from the repository as it is now.
 * A preview is only of a site (`ssg`) whose one vault is plaintext, and only for the account whose connection it is.
 */
async function target(accountId: string, id: number): Promise<{ found: false } | { found: true; deps: PreviewDeps } | { found: true; refusal: SiteRefusal | "unavailable" }> {
  const connection: ConnectionInfo | undefined = await (await connectionService()).get(accountId, id);
  if (!connection) return { found: false };
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { found: false };
  const outcome = await readConnection(accountId, connection);
  if (!outcome.ok) return { found: true, refusal: "unavailable" };
  if (!outcome.read.manifest?.ok || outcome.read.manifest.kind !== "ssg") return { found: true, refusal: "not_a_site" };
  const site = siteVault(outcome.read.discovery.vaults, outcome.read.manifest.ssgEngine);
  if (typeof site === "string") return { found: true, refusal: site };
  return {
    found: true,
    deps: { provider: used.provider, ref: { owner: connection.owner, name: connection.name }, defaultBranch: connection.branch, drafts: await workingCopyService(), connectionId: id, vault: site.vault.directory },
  };
}

export function previewDeps(origin: string): Deps {
  return {
    origin,
    async list(accountId, id) {
      const found = await target(accountId, id);
      if (!found.found) return { found: false };
      if ("refusal" in found) return { found: true, result: { ok: false, reason: found.refusal } };
      const pending = await candidates(found.deps, accountId);
      if ("ok" in pending) return { found: true, result: { ok: false, reason: pending.reason } };
      const listing: Listing = { previews: await previewsOf(found.deps, accountId), pending: { files: pending.files.map((file) => file.path), skipped: pending.skipped } };
      return { found: true, result: { ok: true, listing } };
    },
    async start(accountId, id, author: Identity) {
      const found = await target(accountId, id);
      if (!found.found) return { found: false };
      if ("refusal" in found) return { found: true, result: { ok: false, reason: found.refusal === "unavailable" ? "not_a_site" : found.refusal } };
      return { found: true, result: await startPreview(found.deps, { accountId, author }) };
    },
    async stop(accountId, id, branch) {
      const found = await target(accountId, id);
      if (!found.found) return { found: false };
      if ("refusal" in found) return { found: true, result: { ok: false, reason: found.refusal === "unavailable" ? "not_a_site" : found.refusal } };
      return { found: true, result: await stopPreview(found.deps, { accountId, branch }) };
    },
  };
}

