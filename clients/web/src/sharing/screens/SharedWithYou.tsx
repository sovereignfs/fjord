import { SignedInShell } from '../../auth/screens/SignedInShell';
import styles from '../../auth/screens/screens.module.css';
import { Badge, Card } from '@sovereignfs/ui';
import { SetIcon } from '../../ui/icons';
import type { SharedListing } from '../open';
import listing from './SharedWithYou.module.css';
import { dayText } from '../../ui/dates';

const ROLE_WORDS = { view: 'Can view', comment: 'Can comment', edit: 'Can edit' } as const;

/** A time as the list says it: the day, in UTC. */
const day = (time: number) => dayText(time);

/**
 * *Shared with you* (the owner's request): what other accounts on this instance have shared with the person, as a place of its own, like a drive's listing. The files stay with their owners; each
 * opens at `/d/<id>` in the editor its role allows (read, comment, or edit, whose changes are kept for the owner to review). Nothing here is a repository of the person's: it has no folders, and nothing
 * can be made, moved or deleted in it.
 */
export function SharedWithYou({
  user,
  documents,
  unreadable,
}: {
  user: { id: string; name: string; email: string; image?: string | null | undefined };
  documents: SharedListing[];
  unreadable: number;
}) {
  return (
    <SignedInShell user={user} place="shared">
      <div className={styles.workspace}>
        <h1 className={styles.title}>Shared with you</h1>
        <p className={styles.lead}>
          Documents other people on this instance have shared with you. They stay with their owners:
          what you change is kept for them to review.
        </p>
        {documents.length === 0 ? (
          <Card padding="lg">
            <p className={styles.itemMeta} data-testid="shared-empty">
              {unreadable > 0
                ? 'Nothing that is shared with you could be read just now. Try again in a moment.'
                : 'Nothing has been shared with you yet.'}
            </p>
          </Card>
        ) : (
          <ul className={listing.list} aria-label="Documents shared with you">
            {documents.map((document) => (
              <li key={document.docId}>
                <a href={`/d/${document.docId}`} className={listing.row}>
                  <span className={listing.icon} aria-hidden>
                    <SetIcon name="file-text" />
                  </span>
                  <span className={listing.main}>
                    <span className={listing.name}>{document.title}</span>
                    <span className={listing.meta}>
                      {document.sharedBy ? `Shared by ${document.sharedBy}` : 'Shared with you'} ·{' '}
                      {day(document.sharedAt)}
                    </span>
                  </span>
                  <Badge>{ROLE_WORDS[document.role]}</Badge>
                </a>
              </li>
            ))}
          </ul>
        )}
        {documents.length > 0 && unreadable > 0 ? (
          <p className={styles.itemMeta}>
            {unreadable === 1
              ? 'One more could not be read just now.'
              : `${unreadable} more could not be read just now.`}
          </p>
        ) : null}
      </div>
    </SignedInShell>
  );
}
