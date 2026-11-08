import { authConfig, getSession } from "../auth/server";
import { readConnection } from "../browse/server";
import { connectionService } from "../connections/server";
import { remove as deletePath } from "../files/server";
import { fjord } from "../format/wasm";
import { isProviderError } from "../providers/errors";
import { type ImageDeps, MAX_IMAGE_BYTES, deleteImageOutsideVault, isLibraryPath, listImages, postsShowing, uploadImages } from "./images";
import { type ImagesDeps, MAX_SERVED_BYTES } from "./images-http";
import { type SiteRefusal, siteVault } from "./posts";
import type { Caller } from "../working/http";

/**
 * What `images-http.ts` needs to answer a caller (RFC 0004): the connection must be theirs and a site whose vault can be written to, and every
 * read and write goes through the connection's own token on its branch, as `posts.ts` does.
 */
async function siteOf(accountId: string, id: number): Promise<{ found: false } | { found: true; refusal: SiteRefusal } | { found: true; deps: ImageDeps; vault: string; engine: "astro" | "jekyll" }> {
  const used = await (await connectionService()).provider(accountId, id);
  if (!used) return { found: false };
  const outcome = await readConnection(accountId, used.connection);
  // A repository that cannot be read now is not one whose library can be shown; the caller is told it is not a site, which is what it is to them.
  if (!outcome.ok || !outcome.read.manifest?.ok || outcome.read.manifest.kind !== "ssg") return { found: true, refusal: "not_a_site" };
  const site = siteVault(outcome.read.discovery.vaults, outcome.read.manifest.ssgEngine);
  if (typeof site === "string") return { found: true, refusal: site };
  return {
    found: true,
    vault: site.vault.directory,
    engine: site.engine,
    deps: { provider: used.provider, ref: { owner: used.connection.owner, name: used.connection.name }, branch: used.connection.branch, format: fjord() },
  };
}

export function imagesDeps(origin: string): ImagesDeps {
  return {
    origin,
    async list(accountId, id) {
      const site = await siteOf(accountId, id);
      if (!site.found) return { found: false };
      if ("refusal" in site) return { found: true, result: { ok: false, reason: site.refusal } };
      const listed = await listImages(site.deps, { vault: site.vault, engine: site.engine });
      return { found: true, result: listed.ok ? { ok: true, dir: listed.dir, images: listed.images } : listed };
    },
    async upload(accountId, id, input) {
      const site = await siteOf(accountId, id);
      if (!site.found) return { found: false };
      if ("refusal" in site) return { found: true, result: { ok: false, reason: site.refusal } };
      return { found: true, result: await uploadImages(site.deps, { vault: site.vault, engine: site.engine, ...input }) };
    },
    async remove(accountId, id, input) {
      const site = await siteOf(accountId, id);
      if (!site.found) return { found: false };
      if ("refusal" in site) return { found: true, result: { ok: false, reason: site.refusal } };
      if (!isLibraryPath(site.deps, { vault: site.vault, engine: site.engine, path: input.path })) return { found: true, result: { ok: false, reason: "not_in_library" } };
      // Inside the vault it is deleted as any file is, which keeps it for *What was deleted*; outside it (a Jekyll `_posts` site's assets/images) there is no vault to record it in, and git has it.
      if (site.vault !== "" && input.path.startsWith(`${site.vault}/`)) {
        const done = await deletePath(accountId, id, { vault: site.vault, target: { type: "file", path: input.path, blob: input.blob }, author: input.author });
        return { found: true, result: done.ok ? { ok: true, commit: done.commit } : { ok: false, reason: done.reason === "gone" || done.reason === "upstream_changed" ? done.reason : done.reason === "protected" || done.reason === "too_many" || done.reason === "folder_changed" || done.reason === "has_drafts" || done.reason === "draft_not_saved" ? "not_in_library" : done.reason } };
      }
      return { found: true, result: await deleteImageOutsideVault(site.deps, { vault: site.vault, engine: site.engine, ...input }) };
    },
    async uses(accountId, id, path) {
      const site = await siteOf(accountId, id);
      if (!site.found) return { found: false };
      if ("refusal" in site) return { found: true, result: { ok: false, reason: site.refusal } };
      return { found: true, result: await postsShowing(site.deps, { vault: site.vault, imagePath: path }) };
    },
    async read(accountId, id, path) {
      const site = await siteOf(accountId, id);
      if (!site.found) return { found: false };
      if ("refusal" in site) return { found: true, result: { ok: false, reason: site.refusal } };
      if (!isLibraryPath(site.deps, { vault: site.vault, engine: site.engine, path })) return { found: true, result: { ok: false, reason: "missing" } };
      const { provider, ref, branch } = site.deps;
      const head = await provider.getHead(ref, branch);
      if (!head.changed) throw new Error("the host answered a head request with no etag as unchanged");
      const parent = path.slice(0, path.lastIndexOf("/"));
      const entries = await provider.listDirectory(ref, head.head.commit, parent).catch((error: unknown) => {
        if (isProviderError(error, "not_found")) return [];
        throw error;
      });
      const entry = entries.find((candidate) => candidate.path === path && candidate.kind === "file");
      if (!entry) return { found: true, result: { ok: false, reason: "missing" } };
      try {
        const bytes = await provider.readBlob(ref, entry.id, { maxBytes: Math.max(MAX_SERVED_BYTES, MAX_IMAGE_BYTES) });
        const extension = fjord().siteImageType(bytes);
        return { found: true, result: { ok: true, bytes, mime: extension === undefined ? undefined : fjord().siteImageMime(extension) } };
      } catch (error) {
        if (isProviderError(error, "too_large")) return { found: true, result: { ok: false, reason: "too_large" } };
        throw error;
      }
    },
  };
}

/** Who is calling, and what the library's routes need. Null when the instance has no sign-in at all, so there are no connections and no route (404). */
export async function imagesContext(): Promise<{ caller: Caller | null; deps: ImagesDeps } | null> {
  const config = authConfig();
  if (!config.enabled) return null;
  const session = await getSession();
  return { caller: session ? { accountId: session.user.id, name: session.user.name, email: session.user.email } : null, deps: imagesDeps(config.url) };
}
