import { siteVault } from "../site/posts";
import { BuildStatus } from "../site/screens/BuildStatus";
import { NewPost } from "../site/screens/NewPost";
import { PreviewPanel } from "../site/screens/PreviewPanel";
import { Timeline } from "../journal/screens/Timeline";
import { Alert } from "../ui";
import styles from "../auth/screens/screens.module.css";
import type { EntryViewProps, KindModule } from "./types";

/**
 * A site (spec §3.1, `ssg`): one plaintext vault of the posts an Astro or Jekyll site is built from, presented as the site and never as a
 * list of one vault. Its entry view is the build's status as the host reports it (ROADMAP 3c.3), the action to write a post and previewing unsaved changes through the host (3d.1), above the posts, newest first, drafts marked (ROADMAP 3c.2); the engine's
 * own files are the site's code and are not edited here (Show files has them). The content model is fixed per engine: a title, a `date`,
 * `tags` and whether it is a draft. Where a post goes is the engine's rule (`fjord-core`'s `site`).
 */
export const ssgKind: KindModule = {
  id: "ssg",
  label: "Site",
  editor: "note",
  writingView: false,
  EntryView: SiteEntry,
  contentModel: { placement: "engine", fields: ["title", "date", "tags", "draft", "description"] },
  actions: [{ id: "new-post", label: "New post" }, { id: "build-status", label: "Build status" }, { id: "preview", label: "Preview" }],
};

async function SiteEntry({ accountId, connection, read, query }: EntryViewProps) {
  const manifest = read.manifest?.ok ? read.manifest : undefined;
  const site = siteVault(read.discovery.vaults, manifest?.ssgEngine ?? null);
  if (typeof site === "string") {
    return (
      <Alert variant="warning" heading="This site cannot be edited from here">
        {site === "unknown_engine"
          ? "Its engine is not one this version knows (Astro or Jekyll), so it does not know where a post goes. Show its files to see them."
          : site === "unsupported_site"
            ? "Its vault cannot be written to from here: its manifest cannot be read, it is encrypted, or its files are not named plainly."
            : `A site keeps its posts in one vault, and this repository has ${read.discovery.vaults.length}. Show its files to see them, or change its kind.`}
      </Alert>
    );
  }
  return (
    <section aria-labelledby="site-title">
      <h2 id="site-title" className={styles.title}>
        {manifest?.name ?? "Site"}
      </h2>
      <p className={styles.itemMeta}>
        Built with {site.engine === "astro" ? "Astro" : "Jekyll"}. Its posts are written here; its pages, layouts and settings are the site's code, and are in the files.
      </p>
      <BuildStatus accountId={accountId} connection={connection} commit={read.commit} />
      <NewPost connectionId={connection.id} repo={connection.publicId} engine={site.engine} />
      <PreviewPanel connectionId={connection.id} />
      {read.partial ? (
        <Alert variant="info">This site is too large to list at once, so its posts cannot be shown here. Show its files to browse them.</Alert>
      ) : (
        <Timeline accountId={accountId} connection={connection} read={read} vault={site.vault} query={query} empty="No posts yet." docBase="post" />
      )}
    </section>
  );
}
