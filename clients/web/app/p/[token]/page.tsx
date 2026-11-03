import { notFound } from "next/navigation";
import styles from "../../../src/auth/screens/screens.module.css";
import { openPublishedFor } from "../../../src/publishing/server";

export const dynamic = "force-dynamic";
// A published page is for whoever has its address: not for a search engine to keep.
export const metadata = { title: "Shared page", robots: { index: false, follow: false } };

/**
 * A Doc published as a page (DESIGN.md §12, ROADMAP 3h.1): its title and its Markdown rendered by an allowlist (`src/publishing/render.ts`), read-only, for anyone
 * with the address and no account. The token in the path is the way in; a token that opens nothing, a page that was unpublished and a Doc that is gone are the same
 * 404. Nothing of the repository but the Doc's words is shown.
 */
export default async function PublishedPage({ params }: { params: Promise<{ token: string }> }) {
  const page = await openPublishedFor((await params).token);
  if (!page) notFound();
  return (
    <main className={styles.page}>
      <article className={styles.account}>
        <h1 className={styles.title}>{page.title}</h1>
        {/* The HTML is written by `renderMarkdown`, which writes only a few fixed tags and escapes every piece of the document's text. */}
        <div dangerouslySetInnerHTML={{ __html: page.html }} />
      </article>
    </main>
  );
}
