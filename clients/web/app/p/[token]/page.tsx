import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import styles from '../../../src/auth/screens/screens.module.css';
import body from '../../../src/publishing/Published.module.css';
import { Alert, Card } from '../../../src/ui';
import { PagePasswordForm } from '../../../src/publishing/PagePasswordForm';
import { PublishedComments } from '../../../src/publishing/PublishedComments';
import { openPublishedFor } from '../../../src/publishing/server';
import { PUBLICATION_COOKIE } from '../../../src/publishing/unlock';
import { unlockPageAction } from './actions';
import { momentText } from '../../../src/ui/dates';

export const dynamic = 'force-dynamic';
// A published page is for whoever has its address: not for a search engine to keep.
export const metadata = { title: 'Shared page', robots: { index: false, follow: false } };

/** A date as the page says it: the day and the time, in UTC, which the page says. */
function when(value: string | null): string | undefined {
  if (value === null) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return momentText(time);
}

/**
 * A Doc published as a page (DESIGN.md §12, ROADMAP 3h.1): its Markdown rendered by an allowlist (`src/publishing/render.ts`), read-only, for anyone with the address and no account, **with a password
 * if the owner set one**: then nothing of the document, not its title, is sent until it was given, whoever is asking. The token in the path is the way in; a token that opens nothing, a page that
 * was unpublished and a Doc that is gone are the same 404. Nothing of the repository but the Doc's words, who published it and when it was made and last changed is shown. The title is
 * not put above a document that begins with its own heading.
 */
export default async function PublishedPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ wrong?: string }>;
}) {
  const { token } = await params;
  const { wrong } = await searchParams;
  const proof = (await cookies()).get(PUBLICATION_COOKIE)?.value;
  const opened = await openPublishedFor(token, proof);
  if (!opened) notFound();
  if (opened.state === 'locked') {
    return (
      <main className={styles.page}>
        <div className={styles.account}>
          <h1 className={styles.title}>This page needs a password</h1>
          <Card as="article" padding="lg">
            {wrong ? (
              <div className={styles.notice}>
                <Alert
                  variant="error"
                  heading={wrong === 'wait' ? 'Too soon' : 'That was not the password'}
                >
                  {wrong === 'wait'
                    ? 'Wait a little before trying again; each try makes the next wait longer.'
                    : 'Try again.'}
                </Alert>
              </div>
            ) : null}
            <PagePasswordForm token={token} action={unlockPageAction} />
          </Card>
        </div>
      </main>
    );
  }
  const { page } = opened;
  const created = when(page.created);
  const updated = when(page.updated);
  const facts = [
    page.author ? `By ${page.author}` : undefined,
    created ? `Created ${created}` : undefined,
    updated ? `Updated ${updated}` : undefined,
  ].filter((fact) => fact !== undefined);
  return (
    <main className={styles.page}>
      <article className={styles.account}>
        {page.startsWithHeading ? null : <h1 className={styles.title}>{page.title}</h1>}
        {facts.length > 0 ? (
          <p className={styles.itemMeta} data-testid="page-facts">
            {facts.join(' · ')}
          </p>
        ) : null}
        {/* The HTML is written by `renderMarkdown`, which writes only a few fixed tags and escapes every piece of the document's text. */}
        <div className={body.body} dangerouslySetInnerHTML={{ __html: page.html }} />
        <PublishedComments mode={page.comments} />
      </article>
    </main>
  );
}
