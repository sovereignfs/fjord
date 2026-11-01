import { notFound } from "next/navigation";
import { localAuthConfig, requireSession } from "../../auth/server";
import { safeSegments } from "../location";
import { Landing } from "../screens/Landing";
import { FolderView } from "../screens/FolderView";
import { assessSetupFor, locateInRepository, readConnection, readNoteFor, recordFileRead } from "../server";
import { RepositoryView } from "../../connections/screens/RepositoryView";
import { connectionService } from "../../connections/server";
import { encryptionKeyring } from "../../crypto/server";
import { Alert } from "../../ui";
import { previewCombineFor, workingCopyService } from "../../working/server";
import { headerOf } from "../document";
import { docIdOf } from "../ids";
import type { RepositoryRead } from "../repository";
import { fjord } from "../../format/wasm";
import { DeletedUpstream } from "../screens/DeletedUpstream";
import type { EncryptedCreate } from "../screens/NewFile";
import { editingFor, recipientsFor } from "../../encrypted/server";

/**
 * One of the account's own repositories (`/repo/<connection>`), and a place inside it: `/repo/<connection>/<vault>/<folders…>`
 * is a folder, and down to a file's name is the file (ROADMAP 1a.11). Someone else's repository, a path that is not there and
 * one that tries to climb out are all a 404 and nothing more. `path` is the decoded segments. `/doc/<id>` and `/note/<id>`
 * show a file the same way, once the id has been found (ROADMAP 1b.6).
 */
export async function RepositoryScreen({ connection, path }: { connection: string; path: string[] | undefined }) {
  const { user } = await requireSession();
  if (!/^[1-9][0-9]{0,15}$/.test(connection) || encryptionKeyring() === undefined) notFound();
  const connections = await (await connectionService()).list(user.id);
  const current = connections.find((c) => c.id === Number(connection));
  if (!current) notFound();

  const outcome = await readConnection(user.id, current);
  const segments = path === undefined ? undefined : safeSegments(path);
  if (path !== undefined && path.length > 0 && segments === undefined) notFound();

  let content;
  if (outcome.ok && segments !== undefined && segments.length > 0) {
    const found = await locateInRepository(user.id, current, outcome.read, segments);
    if (!found.ok) {
      content = (
        <Alert variant="error" heading="This cannot be shown right now">
          {found.problem.message}
        </Alert>
      );
    } else if (found.location.kind === "missing") {
      // Not in the repository any more; but if it was being edited here, those changes are not lost (ROADMAP 1b.10).
      const orphan = segments.length > 1 ? await (await workingCopyService()).get(current.id, segments.join("/")) : undefined;
      if (!orphan) notFound();
      content = <DeletedUpstream connectionId={current.id} path={segments.join("/")} label={segments[segments.length - 1] as string} text={orphan.content} />;
    } else {
      // A note or a document in a plaintext vault is shown in its editor; reading it is the only thing that touches the file.
      const file = found.location.kind === "file" ? found.location.file : undefined;
      const note = file?.kind === "note" || file?.kind === "document" ? await readNoteFor(user.id, current, outcome.read, file.path) : undefined;
      // Reading it tells which Doc it is, which is how `/doc/<id>` and `/note/<id>` find it later (ROADMAP 1b.6).
      if (file !== undefined && note?.ok) await recordFileRead(current.id, file, note.blob, note.text);
      const docId = file !== undefined && note?.ok ? docIdOf(fjord(), note.text) : null;
      const permalink = file !== undefined && docId !== null ? `/${file.kind === "document" ? "doc" : "note"}/${docId}` : undefined;
      // What was typed here and not yet saved as a version: kept by the server (ROADMAP 1b.8), and found again here.
      const kept = file !== undefined && note?.ok ? await (await workingCopyService()).get(current.id, file.path) : undefined;
      const draft = kept ? { content: kept.content, baseBlob: kept.baseBlob, guests: [...new Set(kept.editors.flatMap((editor) => (editor.type === "guest" ? [editor.name] : [])))] } : null;
      // Edited here while someone changed the note from elsewhere (ROADMAP 1b.10): can the two be combined?
      const preview = kept && note?.ok && kept.baseBlob !== note.blob ? await previewCombineFor(user.id, current.id, kept, note.text) : undefined;
      // What deleting names, as the page shows it now (ROADMAP 1b.12): the file's blob, and how many files are inside a folder.
      const fileBlob = file ? outcome.read.blobs.get(file.path) : undefined;
      // An encrypted file is edited in the browser: its draft is ciphertext, and the browser encrypts to the vault's recipients (ROADMAP 2b.3).
      const encryptedEditing = file?.kind === "payload" && found.location.kind === "file" && found.location.vault.encrypted === true ? await editingFor(user.id, current, outcome.read, found.location.vault.directory, file.path) : undefined;
      // A new file in an encrypted vault is written and encrypted in the browser, to the vault's recipients (ROADMAP 2b.4).
      const vaultHere = found.location.kind === "folder" ? found.location.vault : undefined;
      const naming: "plain" | "id" | undefined = vaultHere?.fileNaming === "id" ? "id" : vaultHere?.fileNaming === "plain" ? "plain" : undefined;
      const encryptedCreate: EncryptedCreate | undefined =
        vaultHere?.encrypted === true && vaultHere.manifestError === null && naming !== undefined
          ? { naming, recipients: await recipientsFor(user.id, current, outcome.read, vaultHere.directory) }
          : undefined;
      const prefix = `${segments.join("/")}/`;
      const folderFiles = found.location.kind === "folder" && !outcome.read.partial ? [...outcome.read.blobs.keys()].filter((path) => path.startsWith(prefix)).length : undefined;
      // A note or a document is a header and a body, and its editor is given the body: where that starts in the text shown, what
      // the header says, and the header a file with none is given on its first edit (ROADMAP 1b.3, 1b.5).
      const header = file !== undefined && note?.ok ? headerOf(fjord(), draft?.content ?? note.text, file.path.slice(file.path.lastIndexOf("/") + 1)) : undefined;
      content = <FolderView connectionId={current.id} repository={`${current.owner}/${current.name}`} location={found.location} note={note} draft={draft} preview={preview} fileBlob={fileBlob} encryptedEditing={encryptedEditing} encryptedCreate={encryptedCreate} folderFiles={folderFiles} header={header} permalink={permalink} docId={file?.kind === "document" ? (docId ?? undefined) : undefined} destinations={moveDestinations(outcome.read)} />;
    }
  }

  const landing = content === undefined && (path === undefined || path.length === 0) ? <Landing accountId={user.id} connection={current} outcome={outcome} /> : undefined;
  return <RepositoryView user={user} connections={connections} current={current} outcome={outcome} content={content} landing={landing} setup={landing ? await assessSetupFor(user.id, current, outcome) : undefined} security={localAuthConfig() !== undefined} />;
}

/**
 * The folders a file or folder can be moved to (ROADMAP 1b.11): the top of every plaintext vault with plain names, and every
 * folder in them, repository-relative. A repository too large to list names no folders, so none is offered there; the top
 * of each vault still is. At most 300, the vault tops first.
 */
function moveDestinations(read: RepositoryRead): string[] {
  const tops: string[] = [];
  const folders = new Set<string>();
  for (const vault of read.discovery.vaults) {
    if (vault.manifestError !== null || vault.encrypted !== false || vault.fileNaming !== "plain") continue;
    tops.push(vault.directory);
    for (const file of vault.files) {
      const segments = file.path.split("/").slice(0, -1);
      for (let i = 2; i <= segments.length; i++) folders.add(segments.slice(0, i).join("/"));
    }
  }
  return [...tops, ...[...folders].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1))].slice(0, 300);
}
