import { Alert, Badge, Icon } from "../../ui";
import styles from "../../auth/screens/screens.module.css";
import type { ClassifiedFile, FileKind } from "../../format/types";
import { repositoryHref } from "../links";
import type { Location } from "../location";
import type { NoteText } from "../note";
import { NoteView } from "./NoteView";

/**
 * A folder of a vault, or one file of it, as a list (DESIGN.md §8). What can be opened is decided from the name alone,
 * so nothing is downloaded to draw it: a document (`*.fj.md`) and a note (any other `.md`) are links; any other file is
 * greyed out; and everything in an encrypted vault is locked, with its name and no way in (phase 2).
 */
export function FolderView({
  connectionId,
  repository,
  location,
  note,
}: {
  connectionId: number;
  repository: string;
  location: Exclude<Location, { kind: "missing" }>;
  /** For a note: its text, or why there is none. */
  note?: NoteText | { ok: false; reason: "problem"; message: string } | undefined;
}) {
  const here = (...segments: string[]) => repositoryHref(connectionId, ...segments);
  const vault = location.vault;
  const inside = location.kind === "folder" ? location.path : location.kind === "file" ? location.file.relative.split("/").slice(0, -1).join("/") : "";
  const folders = inside === "" ? [] : inside.split("/");

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

      {location.kind === "unreadable" ? (
        <Alert variant="error" heading="This vault cannot be read">
          Its manifest is missing or is not valid JSON, so its files are not known: {vault.manifestError}
        </Alert>
      ) : null}

      {location.kind === "file" ? <FileCard file={location.file} encrypted={vault.encrypted === true} note={note} /> : null}

      {location.kind === "folder" ? (
        <>
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
  // Greyed out, not linked: nothing opens it in this version. An encrypted vault's files are locked besides.
  const locked = file.kind === "payload";
  return (
    <span aria-disabled="true" style={{ opacity: 0.6 }} title={locked ? "Encrypted: files in encrypted vaults cannot be opened in this version" : "This kind of file cannot be opened in this version"}>
      <Icon name={locked ? "lock" : "file"} aria-label={locked ? "Locked" : "Not openable"} /> {name}
      {KIND_LABEL[file.kind] !== "" ? <span className={styles.itemMeta}> · {KIND_LABEL[file.kind]}</span> : null}
      {size}
    </span>
  );
}

function FileCard({ file, encrypted, note }: { file: ClassifiedFile; encrypted: boolean; note: NoteText | { ok: false; reason: "problem"; message: string } | undefined }) {
  return (
    <section aria-labelledby="file-title">
      <h2 id="file-title" className={styles.title} style={{ fontSize: "var(--sv-font-size-lg)" }}>
        {leaf(file.logical)}
      </h2>
      <p className={styles.itemMeta}>
        {KIND_LABEL[file.kind] || "File"}
        {file.size > 0 ? ` · ${humanSize(file.size)}` : ""}
      </p>
      {file.kind === "note" && note ? (
        note.ok ? (
          <>
            <p className={styles.itemMeta}>You are reading this note. Editing it comes with saving: working copies and versions are the next things to be built.</p>
            <NoteView text={note.text} label={leaf(file.logical)} />
          </>
        ) : (
          <Alert variant="warning" heading="This note cannot be shown">
            {note.message}
          </Alert>
        )
      ) : openable(file.kind) ? (
        <Alert variant="info" heading="Opening it comes next">
          {file.kind === "document"
            ? "The document editor is the next thing to be built. Until then, this page is where a document will open."
            : "Reading and editing notes in the browser is the next thing to be built. Until then, this page is where a note will open."}
        </Alert>
      ) : encrypted ? (
        <Alert variant="info" heading="Locked">Files in an encrypted vault cannot be opened in this version.</Alert>
      ) : (
        <Alert variant="info" heading="Not openable">This kind of file cannot be opened in this version; it is kept in the repository as it is.</Alert>
      )}
    </section>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
