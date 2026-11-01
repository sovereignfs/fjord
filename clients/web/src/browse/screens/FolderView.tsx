import { Alert, Badge, Icon } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { ClassifiedFile, FileKind } from "../../format/types";
import { repositoryHref } from "../links";
import type { Location } from "../location";
import type { NoteText } from "../note";
import type { Preview } from "../../working/resolve";
import { checkVault } from "../../files/create";
import { DeleteButton } from "./DeleteButton";
import { MoveButtons } from "./MoveButtons";
import { SharePanel } from "../../sharing/SharePanel";
import { NewFile, type EncryptedCreate } from "./NewFile";
import { UndoBanner } from "./UndoBanner";
import type { HeaderInfo } from "../document";
import { type DraftOfNote, NoteView } from "./NoteView";
import { UpstreamChanged } from "./UpstreamChanged";
import { EncryptedFile, type EncryptedDraft } from "../../keys/screens/EncryptedFile";

/**
 * A folder of a vault, or one file of it, as a list (DESIGN.md §8). What can be opened is decided from the name alone,
 * so nothing is downloaded to draw it: a document (`*.fj.md`) and a note (any other `.md`) are links; any other file is
 * greyed out; and an encrypted file is a link with a lock, opened in the browser with the identity kept there (phase 2).
 */
export function FolderView({
  connectionId,
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
  destinations,
}: {
  connectionId: number;
  repository: string;
  location: Exclude<Location, { kind: "missing" }>;
  /** For a note: its text, or why there is none. */
  note?: NoteText | { ok: false; reason: "problem"; message: string } | undefined;
  /** For a note: the draft of it that was kept, if there is one (ROADMAP 1b.8). */
  draft?: DraftOfNote | null | undefined;
  /** For a note whose draft is of an older version than the repository has: whether the two combine (ROADMAP 1b.10). */
  preview?: Preview | undefined;
  /** For a file: its blob in the repository now, which deleting it names (ROADMAP 1b.12). Not known for a repository too large to list. */
  fileBlob?: string | undefined;
  /** For an encrypted file: its draft (ciphertext) if there is one, and the vault's recipients, which what is typed is encrypted to (ROADMAP 2b.3). */
  encryptedEditing?: { draft: EncryptedDraft | null; recipients: { ok: true; text: string } | { ok: false; message: string } } | undefined;
  /** For a folder of an encrypted vault: what a new file there is made with (ROADMAP 2b.4). */
  encryptedCreate?: EncryptedCreate | undefined;
  /** For a folder: how many files are anywhere inside it now, which deleting it names. Not known for a repository too large to list. */
  folderFiles?: number | undefined;
  /** For a note or a document: where its body starts in the text shown, its properties, and the header it is given on its first edit; undefined if its header cannot be read (then it is shown whole, as Markdown). */
  header?: HeaderInfo | undefined;
  /** For a note or a document whose header has an `id`: its address that does not depend on where it is (`/doc/<id>`, `/note/<id>`). */
  permalink?: string | undefined;
  /** For a document whose header has an `id`: what it can be shared by (ROADMAP 1c.7). */
  docId?: string | undefined;
  /** The folders of plaintext vaults a file or folder can be moved to, repository-relative; none for a repository too large to list. */
  destinations?: string[] | undefined;
}) {
  const here = (...segments: string[]) => repositoryHref(connectionId, ...segments);
  const vault = location.vault;
  const inside = location.kind === "folder" ? location.path : location.kind === "file" ? location.file.relative.split("/").slice(0, -1).join("/") : "";
  const folders = inside === "" ? [] : inside.split("/");
  const writable = checkVault([vault], vault.directory) === "ok";

  return (
    <>
      <nav aria-label="Path" className={styles.itemMeta}>
        <a href={here()}>{repository}</a>
        {" / "}
        <a href={here(vault.directory)}>{vault.name ?? vault.directory}</a>
        {folders.map((folder, index) => (
          <span key={folders.slice(0, index + 1).join("/")}>
            {" / "}
            <a href={here(vault.directory, ...folders.slice(0, index + 1))}>{folder}</a>
          </span>
        ))}
        {location.kind === "file" ? <span> / {location.file.relative.split("/").at(-1)}</span> : null}
      </nav>

      {location.kind === "folder" ? <UndoBanner connectionId={connectionId} /> : null}

      {location.kind === "unreadable" ? (
        <Alert variant="error" heading="This vault cannot be read">
          Its manifest is missing or is not valid JSON, so its files are not known: {vault.manifestError}
        </Alert>
      ) : null}

      {location.kind === "file" ? <FileCard connectionId={connectionId} file={location.file} encrypted={vault.encrypted === true} naming={vault.fileNaming === "id" ? "id" : "plain"} note={note} draft={draft ?? null} preview={preview ?? { state: "unavailable" }} header={header} permalink={permalink} docId={docId} destinations={destinations ?? []} blob={fileBlob} encryptedEditing={encryptedEditing}
          remove={writable && fileBlob !== undefined && (location.file.kind === "note" || location.file.kind === "document") ? { vault: vault.directory, blob: fileBlob, goTo: [vault.directory, ...folders] } : undefined} /> : null}

      {location.kind === "folder" ? (
        <>
          {writable ? <NewFile connectionId={connectionId} vault={vault.directory} folder={location.path} /> : null}
          {encryptedCreate ? <NewFile connectionId={connectionId} vault={vault.directory} folder={location.path} encrypted={encryptedCreate} /> : null}
          {writable && location.path !== "" && folderFiles !== undefined && folderFiles > 0 ? (
            <MoveButtons
              connectionId={connectionId}
              vault={vault.directory}
              target={{ type: "folder", path: `${vault.directory}/${location.path}`, files: folderFiles }}
              suffix=""
              destinations={destinations ?? []}
            />
          ) : null}
          {writable && location.path !== "" && folderFiles !== undefined && folderFiles > 0 ? (
            <DeleteButton
              connectionId={connectionId}
              vault={vault.directory}
              target={{ type: "folder", path: `${vault.directory}/${location.path}`, files: folderFiles }}
              name={folders[folders.length - 1] as string}
              goTo={[vault.directory, ...folders.slice(0, -1)]}
            />
          ) : null}
          {location.folders.length + location.files.length === 0 ? (
            <p>{location.path === "" ? "This vault is empty." : "This folder is empty."}</p>
          ) : (
            <ul className={styles.list} aria-label="Folder contents">
              {location.folders.map((folder) => (
                <li key={`d:${folder.name}`} className={styles.item}>
                  <span>
                    <Icon name="folder" aria-hidden /> <a href={here(vault.directory, ...folders, folder.name)}>{folder.name}</a>
                    {folder.files !== null ? <span className={styles.itemMeta}> · {folder.files === 1 ? "1 file" : `${folder.files} files`}</span> : null}
                  </span>
                </li>
              ))}
              {location.files.map((file) => (
                <li key={`f:${file.relative}`} className={styles.item}>
                  <FileRow connectionId={connectionId} vault={vault.directory} file={file} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}

/** What each kind of file is called to a person. */
const KIND_LABEL: Record<FileKind, string> = {
  document: "Document",
  note: "Note",
  payload: "Encrypted",
  stray: "Plaintext in an encrypted vault",
  misplacedPayload: "Encrypted file in a plaintext vault",
  other: "",
};

const openable = (kind: FileKind) => kind === "document" || kind === "note";
/** An encrypted file is a link too (ROADMAP 2b.2): its page asks for the identity that opens it. */
const decryptable = (kind: FileKind) => kind === "payload";
const leaf = (relative: string) => relative.slice(relative.lastIndexOf("/") + 1);

function FileRow({ connectionId, vault, file }: { connectionId: number; vault: string; file: ClassifiedFile }) {
  const name = leaf(file.logical);
  const size = file.size > 0 ? <span className={styles.itemMeta}> · {humanSize(file.size)}</span> : null;

  if (openable(file.kind)) {
    return (
      <span>
        <Icon name="file-text" aria-hidden /> <a href={repositoryHref(connectionId, vault, ...file.relative.split("/"))}>{name}</a> <Badge>{KIND_LABEL[file.kind]}</Badge>
        {size}
      </span>
    );
  }
  if (decryptable(file.kind)) {
    return (
      <span>
        <Icon name="lock" aria-label="Encrypted" /> <a href={repositoryHref(connectionId, vault, ...file.relative.split("/"))}>{name}</a> <Badge>{KIND_LABEL[file.kind]}</Badge>
        {size}
      </span>
    );
  }
  // Greyed out, not linked: nothing opens it in this version.
  return (
    <span aria-disabled="true" style={{ opacity: 0.6 }} title="This kind of file cannot be opened in this version">
      <Icon name="file" aria-label="Not openable" /> {name}
      {KIND_LABEL[file.kind] !== "" ? <span className={styles.itemMeta}> · {KIND_LABEL[file.kind]}</span> : null}
      {size}
    </span>
  );
}

function FileCard({
  connectionId,
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
  destinations,
  blob,
  encryptedEditing,
}: {
  connectionId: number;
  file: ClassifiedFile;
  encrypted: boolean;
  /** How the vault names its files: an `id`-named vault holds its files in containers (spec 6.4). */
  naming: "plain" | "id";
  note: NoteText | { ok: false; reason: "problem"; message: string } | undefined;
  draft: DraftOfNote | null;
  preview: Preview;
  /** Set when the file can be deleted from here: where it is and what the page showed. */
  remove: { vault: string; blob: string; goTo: string[] } | undefined;
  header: HeaderInfo | undefined;
  permalink: string | undefined;
  docId: string | undefined;
  destinations: string[];
  blob: string | undefined;
  encryptedEditing: { draft: EncryptedDraft | null; recipients: { ok: true; text: string } | { ok: false; message: string } } | undefined;
}) {
  return (
    <section aria-labelledby="file-title">
      <h2 id="file-title" className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
        {leaf(file.logical)}
      </h2>
      <p className={styles.itemMeta}>
        {KIND_LABEL[file.kind] || "File"}
        {file.size > 0 ? ` · ${humanSize(file.size)}` : ""}
      </p>
      {(file.kind === "note" || file.kind === "document") && note ? (
        note.ok ? (
          draft && draft.baseBlob !== note.blob ? (
            <UpstreamChanged connectionId={connectionId} path={file.path} label={leaf(file.logical)} mine={draft.content} theirs={note.text} upstreamBlob={note.blob} preview={preview} />
          ) : (
            <>
              <p className={styles.itemMeta}>Your changes are kept as a draft as you type. Save a version to put them in the repository.</p>
              {permalink ? (
                <p className={styles.itemMeta}>
                  Address by id, which does not depend on where the file is: <a href={permalink}>{permalink}</a>
                </p>
              ) : null}
              <NoteView connectionId={connectionId} path={file.path} label={leaf(file.logical)} text={note.text} blob={note.blob} draft={draft} kind={file.kind === "document" ? "document" : "note"} header={header} docId={docId} />
            </>
          )
        ) : (
          <Alert variant="warning" heading="This file cannot be shown">
            {note.message}
          </Alert>
        )
      ) : openable(file.kind) ? (
        <Alert variant="info" heading="Not opened">
          This {file.kind === "document" ? "document" : "note"} could not be read just now. Try again in a moment.
        </Alert>
      ) : file.kind === "payload" ? (
        <EncryptedFile connectionId={connectionId} path={file.path} naming={naming} logical={file.logical} blob={blob} draft={encryptedEditing?.draft ?? null} recipients={encryptedEditing?.recipients ?? { ok: false, message: "This file cannot be edited just now." }} />
      ) : encrypted ? (
        <Alert variant="info" heading="Locked">This file is in an encrypted vault but is not an encrypted file, so it cannot be opened.</Alert>
      ) : (
        <Alert variant="info" heading="Not openable">This kind of file cannot be opened in this version; it is kept in the repository as it is.</Alert>
      )}
      {remove && docId && !encrypted ? <SharePanel connectionId={connectionId} docId={docId} /> : null}
      {remove ? (
        <MoveButtons connectionId={connectionId} vault={remove.vault} target={{ type: "file", path: file.path, blob: remove.blob }} suffix={file.path.match(/\.fj\.md$|\.md$/i)?.[0] ?? ""} destinations={destinations} />
      ) : null}
      {remove ? (
        <DeleteButton connectionId={connectionId} vault={remove.vault} target={{ type: "file", path: file.path, blob: remove.blob }} name={leaf(file.logical).replace(/\.fj\.md$/i, "").replace(/\.md$/i, "")} goTo={remove.goTo} />
      ) : null}
    </section>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
