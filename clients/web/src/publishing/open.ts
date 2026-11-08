import type { DocIndex } from '../browse/doc-index';
import type { Source } from '../browse/ids';
import type { Fjord } from '../format/wasm';
import { readDocument } from '../sharing/open';
import { proofIsRight } from '../sharing/password';
import { TOKEN_PATTERN } from '../sharing/tokens';
import type { CommentMode, PublicationService } from './publications';
import { renderMarkdown } from './render';

/**
 * A published page, for whoever has its address (DESIGN.md §12, ROADMAP 3h.1): the Doc as it is on the repository's default branch **now** (a draft the owner has
 * not saved as a version is never shown), read with the owner's token, its body rendered by the allowlist in `render.ts`. A token that is not one, or was never made,
 * or was ended, and a Doc that is gone, are all the same answer: nothing. What is shown is the title, the rendered body, and who published it and when it was made and last
 * changed; not the path, the header or anything else of the repository. A page published from an encrypted vault (ROADMAP 3h.2) is the plaintext copy the owner's browser handed over,
 * shown the same way (with no dates: the server cannot read the file's).
 *
 * **A page with a password shows nothing of the document until the password was given**: not its title either. Opening it asks for a proof (`password.ts`), which the page's cookie
 * carries once the password was right, and answers `locked` without it. That holds for everyone, signed in or not.
 */
export interface OpenPublishedDeps {
  publications: Pick<PublicationService, 'find'>;
  sourceOf: (connectionId: number) => Promise<Source | undefined>;
  index: DocIndex;
  format: Pick<Fjord, 'parseDocument' | 'impliedTitle'>;
  /** An account's display name, if it is still there. */
  nameOf: (accountId: string) => Promise<string | undefined>;
  /** The server's secret, which the proof that the password was given is keyed with. */
  secret: string;
}

export interface PublishedPage {
  title: string;
  html: string;
  /** Whether the body begins with a heading of its own, in which case the page does not put the title above it again. */
  startsWithHeading: boolean;
  /** Who published it, by their display name. */
  author: string | undefined;
  /** When the document says it was made (its header's `created`), as written; and when its file last changed, as the host writes it. Either may be unknown. */
  created: string | null;
  updated: string | null;
  /** Who may comment on the page. Nothing is built for it yet: the page keeps the setting where comments will go. */
  comments: CommentMode;
}

export type OpenedPublication = { state: 'open'; page: PublishedPage } | { state: 'locked' };

/** Whether Markdown begins (after blank lines) with a heading, in either style. */
export function beginsWithHeading(markdown: string): boolean {
  const text = markdown.replace(/^\uFEFF/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
  return (
    /^ {0,3}#{1,6}(?:[ \t]|$)/.test(text) ||
    /^[^\n]+\r?\n {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/.test(text)
  );
}

export async function openPublished(
  deps: OpenPublishedDeps,
  token: string,
  proof?: string,
): Promise<OpenedPublication | undefined> {
  if (!TOKEN_PATTERN.test(token)) return undefined;
  const found = await deps.publications.find(token);
  if (!found) return undefined;
  if (
    found.passwordHash !== null &&
    !proofIsRight(deps.secret, found.id, found.passwordHash, proof, 'fjord-publication-unlock')
  )
    return { state: 'locked' };
  const author = await deps.nameOf(found.createdBy);
  // A page published from an encrypted vault is the copy that was handed over: there is nothing the server could read.
  if (found.copy) {
    return {
      state: 'open',
      page: {
        title: found.copy.title,
        html: renderMarkdown(found.copy.body),
        startsWithHeading: beginsWithHeading(found.copy.body),
        author,
        created: null,
        updated: new Date(found.createdAt).toISOString(),
        comments: found.comments,
      },
    };
  }
  const doc = await readDocument(deps, found.connectionId, found.docId, false, true);
  if (!doc) return undefined;
  return {
    state: 'open',
    page: {
      title: doc.title,
      html: renderMarkdown(doc.body),
      startsWithHeading: beginsWithHeading(doc.body),
      author,
      created: doc.created,
      updated: doc.modified,
      comments: found.comments,
    },
  };
}

/** Whether a token is a page that asks for a password, for the one place that gives it. */
export async function askedPassword(
  deps: Pick<OpenPublishedDeps, 'publications'>,
  token: string,
): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;
  return (await deps.publications.find(token))?.passwordHash != null;
}
