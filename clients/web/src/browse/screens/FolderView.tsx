import { isPicture } from '../raw';
import { entryHeading, isFiledName } from '../../journal/heading';
import { Alert } from '@sovereignfs/ui';
import { LinkButton } from '../../ui/LinkButton';
import { SetIcon } from '../../ui/icons';
import styles from '../../auth/screens/screens.module.css';
import type { ClassifiedFile, FileKind } from '../../format/types';
import { repositoryHref } from '../links';
import { type AddressBook, addressBookFor } from '../address-book';
import { FILE_ICON, fileIconFor } from '../file-icons';
import type { Location } from '../location';
import type { NoteText } from '../note';
import type { Preview } from '../../working/resolve';
import { checkVault } from '../../files/create';
import { DeleteButton } from './DeleteButton';
import { MoveButtons } from './MoveButtons';
import { ShareDialog } from '../../sharing/ShareDialog';
import { Listing, type ListingItem } from './Listing';
import { NewFile, type EncryptedCreate } from './NewFile';
import { UndoBanner } from './UndoBanner';
import { VaultConversion } from './VaultConversion';
import { type HeaderInfo, documentTitle, stemOf } from '../document';
import { type DraftOfNote, NoteView } from './NoteView';
import { UpstreamChanged } from './UpstreamChanged';
import actions from './FileActions.module.css';
import { EncryptedFile, type EncryptedDraft } from '../../keys/screens/EncryptedFile';
import type { TransferTarget } from '../../keys/files';
import { TransferControl } from './TransferControl';

/**
 * A folder of a vault, or one file of it, as a list (DESIGN.md §8). What can be opened is decided from the name alone,
 * so nothing is downloaded to draw it: a Doc (any `.md`) is a link, any other file in a plaintext vault is a link to its page (a picture is shown, and anything can be saved),
 * and an encrypted file is a link with a lock, opened in the browser with the identity kept there (phase 2).
 */
export async function folderParts({
  html,
  fileSrc,
  connectionId,
  repo,
  repository,
  location,
  note,
  draft,
  preview,
  fileBlob,
  encryptedEditing,
  encryptedCreate,
  folderFiles,
  header,
  permalink,
  docId,
  editor,
  writing,
  site,
  destinations,
  encryptedNaming,
  transferTargets,
  tagSuggestions,
  updated,
}: {
  /** For a document: when it last changed in the repository (ISO 8601; null when the host did not say), shown in its properties. */
  updated?: string | null | undefined;
  connectionId: number;
  /** Where the repository's addresses begin (`ConnectionInfo.address`: `<kind>/<public id>`). */
  repo: string;
  repository: string;
  location: Exclude<Location, { kind: 'missing' }>;
  /** For a note: its text, or why there is none. */
  note?: NoteText | { ok: false; reason: 'problem'; message: string } | undefined;
  /** For a note: the draft of it that was kept, if there is one (ROADMAP 1b.8). */
  draft?: DraftOfNote | null | undefined;
  /** For a note whose draft is of an older version than the repository has: whether the two combine (ROADMAP 1b.10). */
  preview?: Preview | undefined;
  /** For any other file of a plaintext vault: where it is served from (`/raw/<repo>/<handle>/file`). */
  fileSrc?: string | undefined;
  /** For a static HTML page: where the sandboxed document is served from (`/raw/<repo>/<handle>`), which it is shown from in place of a viewer of text. */
  html?: { src: string } | undefined;
  /** For a file: its blob in the repository now, which deleting it names (ROADMAP 1b.12). Not known for a repository too large to list. */
  fileBlob?: string | undefined;
  /** For an encrypted file: its draft (ciphertext) if there is one, and the vault's recipients, which what is typed is encrypted to (ROADMAP 2b.3). */
  encryptedEditing?:
    | {
        draft: EncryptedDraft | null;
        recipients: { ok: true; text: string } | { ok: false; message: string };
      }
    | undefined;
  /** For a folder of an encrypted vault: what a new file there is made with (ROADMAP 2b.4). */
  encryptedCreate?: EncryptedCreate | undefined;
  /** For a folder: how many files are anywhere inside it now, which deleting it names. Not known for a repository too large to list. */
  folderFiles?: number | undefined;
  /** For a note or a document: where its body starts in the text shown, its properties, and the header it is given on its first edit; undefined if its header cannot be read (then it is shown whole, as Markdown). */
  header?: HeaderInfo | undefined;
  /** For a Doc whose header has an `id`: its address that does not depend on where it is (`/d/<id>`). */
  permalink?: string | undefined;
  /** For a Doc whose header has an `id`: what it can be shared by (ROADMAP 1c.7). */
  docId?: string | undefined;
  /** Which editor the repository's kind opens a Doc in (RFC 0002). */
  editor: 'document' | 'note';
  /** Whether a Doc opens as a quiet writing view (a journal's): the editor and the properties, the rest under "More". */
  writing?: boolean | undefined;
  /** Whether the repository is a site (RFC 0002): its posts offer `draft` and `description`, and a visual editor beside the Markdown. */
  site?: boolean | undefined;
  /** For a note or a document: tags in use in the repository, offered while one is typed (ROADMAP 3b.3). */
  tagSuggestions?: string[] | undefined;
  /** The folders of plaintext vaults a file or folder can be moved to, repository-relative; none for a repository too large to list. */
  destinations?: string[] | undefined;
  /** Set for an encrypted vault this version writes: how it names its files. Its files are renamed, moved and deleted as the bytes they are (ROADMAP 2b.5). */
  encryptedNaming?: 'plain' | 'id' | undefined;
  /** For a file: where it can be moved to in another vault when one of the two is encrypted (ROADMAP 2b.6). */
  transferTargets?: TransferTarget[] | undefined;
}) {
  const vault = location.vault;
  const inside =
    location.kind === 'folder'
      ? location.path
      : location.kind === 'file'
        ? location.file.relative.split('/').slice(0, -1).join('/')
        : '';
  const folders = inside === '' ? [] : inside.split('/');
  // The links of this page are drawn from ids (workstream 0003): the handles of the folders above, the folders and files listed, are made in one go.
  const listed =
    location.kind === 'folder'
      ? [
          ...location.folders.map((folder) => [vault.directory, ...folders, folder.name].join('/')),
          ...location.files.map((file) => file.path),
        ]
      : [];
  const book = await addressBookFor({ id: connectionId, address: repo }, vault, [
    ...folders.map((_, index) => [vault.directory, ...folders.slice(0, index + 1)].join('/')),
    ...listed,
  ]);
  const here = (...segments: string[]) =>
    segments.length === 0 ? repositoryHref(repo) : book.href(segments.join('/'));
  const plainWritable = checkVault([vault], vault.directory) === 'ok';
  const writable = plainWritable || encryptedNaming !== undefined;
  // The folder that is open is drawn open in the path above it, as it is drawn closed in the listing of the one that holds it.
  const opened = (
    <SetIcon
      name={FILE_ICON.folderOpen}
      size={14}
      style={{ verticalAlign: '-2px', marginRight: 4 }}
    />
  );

  // The path is drawn outside the card the page is in (the repository's page puts it between the name and the card), the rest inside it.
  const crumbs = (
    <nav
      aria-label="Path"
      className={styles.itemMeta}
      style={{ marginBottom: 'var(--sv-space-3)' }}
    >
      <a href={here()}>{repository}</a>
      {' / '}
      <a href={here(vault.directory)}>
        {location.kind === 'folder' && folders.length === 0 ? opened : null}
        {vault.name ?? vault.directory}
      </a>
      {folders.map((folder, index) => (
        <span key={folders.slice(0, index + 1).join('/')}>
          {' / '}
          <a href={here(vault.directory, ...folders.slice(0, index + 1))}>
            {location.kind === 'folder' && index === folders.length - 1 ? opened : null}
            {folder}
          </a>
        </span>
      ))}
      {location.kind === 'file' ? (
        <span>
          {' '}
          /{' '}
          {location.file.kind === 'doc'
            ? stemOf(leaf(location.file.relative))
            : leaf(location.file.relative)}
        </span>
      ) : null}
    </nav>
  );
  const body = (
    <>
      {location.kind === 'folder' ? <UndoBanner connectionId={connectionId} repo={repo} /> : null}

      {location.kind === 'unreadable' ? (
        <Alert variant="error" heading="This vault cannot be read">
          Its manifest is missing or is not valid JSON, so its files are not known:{' '}
          {vault.manifestError}
        </Alert>
      ) : null}

      {location.kind === 'file' && html ? (
        <HtmlFrame name={leaf(location.file.relative)} src={html.src} />
      ) : null}

      {location.kind === 'file' && !html ? (
        <FileCard
          fileSrc={fileSrc}
          updated={updated}
          connectionId={connectionId}
          repo={repo}
          file={location.file}
          encrypted={vault.encrypted === true}
          naming={vault.fileNaming === 'id' ? 'id' : 'plain'}
          encryptedChange={encryptedNaming}
          note={note}
          draft={draft ?? null}
          preview={preview ?? { state: 'unavailable' }}
          header={header}
          permalink={permalink}
          docId={docId}
          editor={editor}
          writing={writing === true}
          site={site === true}
          destinations={destinations ?? []}
          blob={fileBlob}
          encryptedEditing={encryptedEditing}
          transferTargets={transferTargets ?? []}
          tagSuggestions={tagSuggestions}
          remove={
            writable &&
            fileBlob !== undefined &&
            (location.file.kind === 'doc' ||
              (encryptedNaming !== undefined && location.file.kind === 'payload'))
              ? { vault: vault.directory, blob: fileBlob, goTo: [vault.directory, ...folders] }
              : undefined
          }
        />
      ) : null}

      {location.kind === 'folder' ? (
        <Listing
          label="Folder contents"
          actions={
            <>
              {plainWritable ? (
                <NewFile
                  mode="folder"
                  connectionId={connectionId}
                  repo={repo}
                  vault={vault.directory}
                  folder={location.path}
                />
              ) : null}
              {encryptedCreate?.recipients.ok && encryptedCreate.naming === 'plain' ? (
                <NewFile
                  mode="folder"
                  connectionId={connectionId}
                  repo={repo}
                  vault={vault.directory}
                  folder={location.path}
                  encrypted={encryptedCreate}
                />
              ) : null}
              {plainWritable ? (
                <NewFile
                  connectionId={connectionId}
                  repo={repo}
                  vault={vault.directory}
                  folder={location.path}
                />
              ) : null}
              {encryptedCreate ? (
                <NewFile
                  connectionId={connectionId}
                  repo={repo}
                  vault={vault.directory}
                  folder={location.path}
                  encrypted={encryptedCreate}
                />
              ) : null}
              {location.path === '' &&
              site !== true &&
              (plainWritable || encryptedNaming !== undefined) ? (
                <VaultConversion
                  connectionId={connectionId}
                  vault={vault.directory}
                  encrypted={!plainWritable}
                />
              ) : null}
              {writable && location.path !== '' && folderFiles !== undefined && folderFiles > 0 ? (
                <MoveButtons
                  repo={repo}
                  connectionId={connectionId}
                  vault={vault.directory}
                  target={{
                    type: 'folder',
                    path: `${vault.directory}/${location.path}`,
                    files: folderFiles,
                  }}
                  suffix=""
                  destinations={destinations ?? []}
                />
              ) : null}
              {writable && location.path !== '' && folderFiles !== undefined && folderFiles > 0 ? (
                <DeleteButton
                  repo={repo}
                  connectionId={connectionId}
                  vault={vault.directory}
                  target={{
                    type: 'folder',
                    path: `${vault.directory}/${location.path}`,
                    files: folderFiles,
                  }}
                  name={folders[folders.length - 1] as string}
                  goTo={[vault.directory, ...folders.slice(0, -1)]}
                />
              ) : null}
            </>
          }
          items={[
            ...location.folders.map((folder) => ({
              key: `d:${folder.name}`,
              name: folder.name,
              href: here(vault.directory, ...folders, folder.name),
              icon: FILE_ICON.folder,
              meta:
                folder.files === null
                  ? undefined
                  : folder.files === 1
                    ? '1 file'
                    : `${folder.files} files`,
            })),
            ...location.files.map((file) => rowOf(file, vault.encrypted === false, book)),
          ]}
          empty={<p>{location.path === '' ? 'This vault is empty.' : 'This folder is empty.'}</p>}
        />
      ) : null}
    </>
  );
  return { crumbs, body };
}

/** The page of a folder or a file of a vault: its path and what is in it, as one (for a page that has no card of its own to put the path outside). */
export async function FolderView(props: Parameters<typeof folderParts>[0]) {
  const { crumbs, body } = await folderParts(props);
  return (
    <>
      {crumbs}
      {body}
    </>
  );
}

/** What each kind of file is called to a person. */
const KIND_LABEL: Record<FileKind, string> = {
  doc: 'Document',
  payload: 'Encrypted',
  stray: 'Plaintext in an encrypted vault',
  misplacedPayload: 'Encrypted file in a plaintext vault',
  other: '',
};

const openable = (kind: FileKind) => kind === 'doc';
/** An encrypted file is a link too (ROADMAP 2b.2): its page asks for the identity that opens it. */
const decryptable = (kind: FileKind) => kind === 'payload';
const leaf = (relative: string) => relative.slice(relative.lastIndexOf('/') + 1);

/**
 * A static HTML page run in a sandbox (workstream 0003, leg 5): its own response (`/raw/…`) carries `Content-Security-Policy: sandbox allow-scripts`, so it has no origin of
 * this app's, no cookies and no network, and `sandbox="allow-scripts"` here says the same from this side. It can run a script, draw, and keep what it does in memory
 * only: a checklist made elsewhere works, and forgets its ticks on reload.
 */
function HtmlFrame({ name, src }: { name: string; src: string }) {
  return (
    <section aria-label="Page">
      <p className={styles.itemMeta}>
        Runs in a sandbox: it cannot reach your account, other pages or the network, and keeps
        nothing between visits.
      </p>
      <iframe
        title={name}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={{
          width: '100%',
          height: '75vh',
          border: '1px solid var(--sv-color-border)',
          borderRadius: 'var(--sv-radius-md)',
          background: 'white',
        }}
      />
    </section>
  );
}

/** A file of a folder as a listing draws it: what it is called, whether and where it opens, its icon by its name, a label for what it is, and its size. */
function rowOf(file: ClassifiedFile, plaintext: boolean, book: AddressBook): ListingItem {
  const name = leaf(file.logical);
  const meta = file.size > 0 ? humanSize(file.size) : undefined;
  const icon = fileIconFor(name, file.kind);
  const page = plaintext && /\.html?$/i.test(file.path) && file.kind === 'other';
  if (openable(file.kind))
    return {
      key: `f:${file.relative}`,
      name,
      href: book.href(file.path),
      icon,
      badges: [KIND_LABEL[file.kind]],
      meta,
    };
  if (page)
    return {
      key: `f:${file.relative}`,
      name,
      href: book.htmlHref(file.path),
      icon,
      badges: ['Page'],
      meta,
    };
  if (decryptable(file.kind))
    return {
      key: `f:${file.relative}`,
      name,
      href: book.href(file.path),
      icon,
      badges: [KIND_LABEL[file.kind]],
      meta,
    };
  // Anything else in a plaintext vault has a page of its own, to look at or save (a picture, a PDF, a CSV).
  if (plaintext)
    return {
      key: `f:${file.relative}`,
      name,
      href: book.href(file.path),
      icon,
      badges: KIND_LABEL[file.kind] === '' ? [] : [KIND_LABEL[file.kind]],
      meta,
    };
  // Greyed out, not linked: in an encrypted vault, something that is not ciphertext is not for this page.
  return {
    key: `f:${file.relative}`,
    name,
    icon,
    badges: KIND_LABEL[file.kind] === '' ? [] : [KIND_LABEL[file.kind]],
    meta,
    title: 'This kind of file cannot be opened in this version',
  };
}

function FileCard({
  fileSrc,
  connectionId,
  repo,
  file,
  encrypted,
  naming,
  note,
  draft,
  preview,
  remove,
  header,
  permalink,
  docId,
  editor,
  writing,
  site,
  destinations,
  blob,
  encryptedEditing,
  encryptedChange,
  transferTargets,
  tagSuggestions,
  updated,
}: {
  fileSrc: string | undefined;
  tagSuggestions?: string[] | undefined;
  /** When the file last changed in the repository (ISO 8601), if the host said. */
  updated?: string | null | undefined;
  connectionId: number;
  /** Where the repository's addresses begin (`ConnectionInfo.address`: `<kind>/<public id>`). */
  repo: string;
  file: ClassifiedFile;
  encrypted: boolean;
  /** How the vault names its files: an `id`-named vault holds its files in containers (spec 6.4). */
  naming: 'plain' | 'id';
  note: NoteText | { ok: false; reason: 'problem'; message: string } | undefined;
  draft: DraftOfNote | null;
  preview: Preview;
  /** Set when the file can be deleted from here: where it is and what the page showed. */
  remove: { vault: string; blob: string; goTo: string[] } | undefined;
  header: HeaderInfo | undefined;
  permalink: string | undefined;
  editor: 'document' | 'note';
  writing: boolean;
  site: boolean;
  docId: string | undefined;
  destinations: string[];
  blob: string | undefined;
  /** For a file of an encrypted vault this version writes: how the vault names its files. */
  encryptedChange: 'plain' | 'id' | undefined;
  transferTargets: TransferTarget[];
  encryptedEditing:
    | {
        draft: EncryptedDraft | null;
        recipients: { ok: true; text: string } | { ok: false; message: string };
      }
    | undefined;
}) {
  // What a file's page offers besides the editor, as icons at the end of its title (the owner's request): sharing (with publishing, in a dialog), move, move to another vault, and delete. Rename is not
  // among them for a drive's document, whose properties have its file's name; a file that has no such properties keeps it. A journal's writing view keeps them one step away, under "More".
  const isDoc = file.kind === 'doc';
  const sharing =
    remove && !encrypted && isDoc && (docId || note?.ok) ? (
      <ShareDialog
        connectionId={connectionId}
        docId={docId}
        path={note?.ok ? file.path : undefined}
        blob={note?.ok ? note.blob : undefined}
        hasDraft={draft !== null}
      />
    ) : null;
  // The file's name is in the properties when the page has properties to show: a header it has, or one it would be given. A text it would not give one to (it has carriage returns) has none, and keeps its rename icon.
  const filenameInProperties =
    isDoc &&
    editor === 'document' &&
    (header?.properties !== undefined || header?.promotion !== undefined);
  const icons = remove ? (
    <>
      {sharing}
      <MoveButtons
        appearance="icon"
        connectionId={connectionId}
        repo={repo}
        vault={remove.vault}
        target={{ type: 'file', path: file.path, blob: remove.blob }}
        suffix={
          (file.kind === 'payload'
            ? file.path.match(/(\.[^./]+)?\.age$/i)?.[0]
            : file.path.match(/\.md$/i)?.[0]) ?? ''
        }
        destinations={destinations}
        canRename={!filenameInProperties && encryptedChange !== 'id'}
      />
      {isDoc && note?.ok && transferTargets.length > 0 ? (
        <TransferControl
          appearance="icon"
          repo={repo}
          connectionId={connectionId}
          path={file.path}
          blob={note.blob}
          name={leaf(file.path)}
          text={note.text}
          sourceEncrypted={false}
          targets={transferTargets}
          blocked={
            draft
              ? 'This file has unsaved changes. Save a version of them, or discard them, to move it to another vault.'
              : undefined
          }
        />
      ) : null}
      <DeleteButton
        appearance="icon"
        connectionId={connectionId}
        repo={repo}
        vault={remove.vault}
        target={{ type: 'file', path: file.path, blob: remove.blob }}
        name={leaf(file.logical).replace(/\.md$/i, '')}
        goTo={remove.goTo}
      />
    </>
  ) : null;
  // What a document is called is what it says (its header's title, or its first heading), and its file's name only when it says nothing; the name is in the path above and in its properties.
  const shown = draft?.content ?? (note?.ok ? note.text : undefined);
  const named =
    isDoc && shown !== undefined
      ? documentTitle(shown, header?.bodyStart, header?.properties?.title, leaf(file.logical))
      : leaf(file.logical);
  const title =
    (writing && isFiledName(named) ? entryHeading(header?.properties?.date) : null) ?? named;
  return (
    <section aria-labelledby="file-title">
      <div className={actions.titleRow}>
        <h2 id="file-title" className={actions.title}>
          {title}
          {file.size > 0 ? <span className={actions.size}>{humanSize(file.size)}</span> : null}
        </h2>
        {writing || !icons ? null : (
          <div className={actions.icons}>
            {/* Where a document's editor puts its save control, among the icons (`NoteView`). */}
            <span id="file-actions-slot" style={{ display: 'contents' }} />
            {icons}
          </div>
        )}
      </div>
      {/* Where a document's editor says what has become of what was typed (`NoteView`). */}
      <div id="file-status-slot" />
      {file.kind === 'doc' && note ? (
        note.ok ? (
          draft && draft.baseBlob !== note.blob ? (
            <UpstreamChanged
              connectionId={connectionId}
              path={file.path}
              label={leaf(file.logical)}
              mine={draft.content}
              theirs={note.text}
              upstreamBlob={note.blob}
              preview={preview}
            />
          ) : (
            <>
              <NoteView
                key={note.blob}
                address={writing ? undefined : permalink}
                connectionId={connectionId}
                path={file.path}
                label={leaf(file.logical)}
                text={note.text}
                blob={note.blob}
                draft={draft}
                editor={editor}
                site={site}
                header={header}
                docId={docId}
                tagSuggestions={tagSuggestions}
                rename={
                  remove && editor === 'document' && filenameInProperties
                    ? { vault: remove.vault, repo, suffix: file.path.match(/\.md$/i)?.[0] ?? '' }
                    : undefined
                }
                updated={updated}
              />
            </>
          )
        ) : (
          <Alert variant="warning" heading="This file cannot be shown">
            {note.message}
          </Alert>
        )
      ) : openable(file.kind) ? (
        <Alert variant="info" heading="Not opened">
          This document could not be read just now. Try again in a moment.
        </Alert>
      ) : file.kind === 'payload' ? (
        <EncryptedFile
          key={blob ?? file.path}
          editor={editor === 'document' ? 'document' : 'note'}
          connectionId={connectionId}
          repo={repo}
          path={file.path}
          naming={naming}
          logical={file.logical}
          blob={blob}
          transferTargets={transferTargets}
          draft={encryptedEditing?.draft ?? null}
          recipients={
            encryptedEditing?.recipients ?? {
              ok: false,
              message: 'This file cannot be edited just now.',
            }
          }
        />
      ) : encrypted ? (
        <Alert variant="info" heading="Locked">
          This file is in an encrypted vault but is not an encrypted file, so it cannot be opened.
        </Alert>
      ) : (
        <OtherFile name={leaf(file.logical)} src={fileSrc} />
      )}
      {writing && icons ? (
        <details className={styles.itemMeta} data-testid="more">
          <summary>More</summary>
          <div className={actions.icons} style={{ marginTop: 0 }}>
            {icons}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** A file that is not a document, in a plaintext vault: a picture is shown, and anything can be saved. It is served by `/raw/…/file`, which never lets it run. */
function OtherFile({ name, src }: { name: string; src: string | undefined }) {
  if (src === undefined)
    return (
      <Alert variant="info" heading="Not shown here">
        This file is kept in the repository as it is.
      </Alert>
    );
  return (
    <>
      {isPicture(name) ? (
        // A file of the repository, served by this app: nothing for an image optimiser, and it must not pass through one.
        <img
          src={src}
          alt={name}
          style={{
            display: 'block',
            maxWidth: '100%',
            height: 'auto',
            marginBottom: 'var(--sv-space-4)',
            borderRadius: 'var(--sv-radius-md)',
          }}
        />
      ) : (
        <p className={styles.itemMeta}>
          This kind of file is not shown here. It is kept in the repository as it is.
        </p>
      )}
      <LinkButton href={`${src}?download`} variant="secondary">
        Download
      </LinkButton>
    </>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
