import { notFound, redirect } from "next/navigation";
import { localAuthConfig, requireSession } from "../../auth/server";
import { safeSegments } from "../location";
import { entryFor } from "../../kinds/entry";
import { journalTagsFor } from "../../journal/server";
import { FolderView } from "../screens/FolderView";
import { assessSetupFor, locateInRepository, readConnection, readNoteFor, recordFileRead } from "../server";
import { RepositoryView } from "../../connections/screens/RepositoryView";
import { connectionService } from "../../connections/server";
import { encryptionKeyring } from "../../crypto/server";
import { Alert } from "../../ui";
import { previewCombineFor, workingCopyService } from "../../working/server";
import { headerOf } from "../document";
import { DocIndex } from "../doc-index";
import { FileHandles } from "../handles";
import { docIdOf } from "../ids";
import { getDatabase } from "../../db/boot";
import type { RepositoryRead } from "../repository";
import { fjord } from "../../format/wasm";
import { DeletedUpstream } from "../screens/DeletedUpstream";
import { checkEncryptedVault } from "../../files/create-encrypted";
import type { TransferTarget } from "../../keys/files";
import type { VaultListing } from "../../format/types";
import type { EncryptedCreate } from "../screens/NewFile";
import { editingFor, recipientsFor } from "../../encrypted/server";
import { kindFor } from "../../kinds/registry";

/**
 * One of the account's own repositories (`/repo/<connection>`), and a place inside it: `/repo/<connection>/<vault>/<folders…>`
 * is a folder, and down to a file's name is the file (ROADMAP 1a.11). Someone else's repository, a path that is not there and
 * one that tries to climb out are all a 404 and nothing more. `path` is the decoded segments. `/d/<id>`
 * shows a file the same way, once the id has been found (ROADMAP 1b.6).
 */
export async function RepositoryScreen({ connection, path, view, query = {}, via }: { connection: string; path: string[] | undefined; /** How the page was reached: by a `handle` (`/f/<handle>`), or by a Doc `id` (`/d/<id>`). With neither, a place by its path is sent on to its address that shows no path. */ via?: "handle" | "id" | undefined; /** `files`: show a repository of any kind as a drive (spec §3.1). */ view?: string | undefined; /** The page's query, for an entry view that pages or filters. */ query?: Record<string, string | string[] | undefined> }) {
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
      if (orphan) {
        content = <DeletedUpstream connectionId={current.id} path={segments.join("/")} label={segments[segments.length - 1] as string} text={orphan.content} />;
      } else if (via === "handle") {
        // A handle is of a path (ROADMAP 3e.2): when nothing is there the file was moved outside Fjord or deleted, and it is not guessed at.
        content = (
          <Alert variant="info" heading="Moved or gone">
            There is nothing at this address now. The file or folder it was made for was moved or deleted somewhere other than here. Browse the repository to find it.
          </Alert>
        );
      } else {
        notFound();
      }
    } else {
      // A place reached by its path is sent on to its address that shows no path (RFC 0002): a Doc whose `id` is known to `/d/<id>`, anything else to `/f/<handle>`.
      if (via === undefined) redirect(await addressOf(current.id, segments.join("/"), found.location.kind === "file" ? outcome.read.blobs.get(segments.join("/")) : undefined));
      // A note or a document in a plaintext vault is shown in its editor; reading it is the only thing that touches the file.
      const file = found.location.kind === "file" ? found.location.file : undefined;
      const note = file?.kind === "doc" ? await readNoteFor(user.id, current, outcome.read, file.path) : undefined;
      // Reading it tells which Doc it is, which is how `/d/<id>` finds it later (ROADMAP 1b.6).
      if (file !== undefined && note?.ok) await recordFileRead(current.id, file, note.blob, note.text);
      const docId = file !== undefined && note?.ok ? docIdOf(fjord(), note.text) : null;
      const permalink = file !== undefined && docId !== null ? `/d/${docId}` : undefined;
      // Reached by a handle, a Doc is at its `id` from now on.
      if (via === "handle" && permalink !== undefined) redirect(permalink);
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
      // An encrypted vault this version writes is renamed in, moved in and deleted from as the bytes it holds (ROADMAP 2b.5), but only within itself.
      const vaultOf = found.location.kind === "folder" || found.location.kind === "file" ? found.location.vault : undefined;
      const writtenAs = vaultOf?.encrypted === true ? checkEncryptedVault(outcome.read.discovery.vaults, outcome.read.manifests, vaultOf.directory) : undefined;
      const encryptedNaming = writtenAs?.ok ? writtenAs.target.naming : undefined;
      // Where a file can go in another vault when one of the two is encrypted (ROADMAP 2b.6): the page makes the bytes, so it is given the recipients.
      const movable = file !== undefined && vaultOf !== undefined && fileBlob !== undefined && (file.kind === "payload" ? encryptedNaming !== undefined : file.kind === "doc" && vaultOf.encrypted === false);
      const transferTargets = movable ? transferTargetsFor(outcome.read, vaultOf) : undefined;
      const prefix = `${segments.join("/")}/`;
      const folderFiles = found.location.kind === "folder" && !outcome.read.partial ? [...outcome.read.blobs.keys()].filter((path) => path.startsWith(prefix)).length : undefined;
      // A note or a document is a header and a body, and its editor is given the body: where that starts in the text shown, what
      // the header says, and the header a file with none is given on its first edit (ROADMAP 1b.3, 1b.5).
      const header = file !== undefined && note?.ok ? headerOf(fjord(), draft?.content ?? note.text, file.path.slice(file.path.lastIndexOf("/") + 1)) : undefined;
      // In a plaintext journal, the tags already in use are offered while one is typed (ROADMAP 3b.3): from what its timeline knows.
      const tagSuggestions = note?.ok ? await journalTagsFor(user.id, current, outcome.read) : undefined;
      content = <FolderView tagSuggestions={tagSuggestions} connectionId={current.id} repository={`${current.owner}/${current.name}`} location={found.location} note={note} draft={draft} preview={preview} fileBlob={fileBlob} encryptedEditing={encryptedEditing} encryptedCreate={encryptedCreate} folderFiles={folderFiles} header={header} permalink={permalink} docId={file?.kind === "doc" ? (docId ?? undefined) : undefined} editor={kindFor(outcome.read.manifest).editor} writing={kindFor(outcome.read.manifest).writingView} site={kindFor(outcome.read.manifest).contentModel.fields.includes("draft")} destinations={moveDestinations(outcome.read, encryptedNaming ? found.location.vault.directory : undefined)} encryptedNaming={encryptedNaming} transferTargets={transferTargets} />;
    }
  }

  // What it opens on is its kind's (RFC 0001), or its files when asked: every kind can be shown as a drive.
  const atTop = content === undefined && (path === undefined || path.length === 0);
  const asFiles = view === "files";
  const { kind, entry } = entryFor(user.id, current, outcome, asFiles, query);
  const landing = atTop ? entry : undefined;
  const kindLink = atTop && kind.id !== "drive" ? { label: kind.label, asFiles } : undefined;
  return <RepositoryView user={user} connections={connections} current={current} outcome={outcome} content={content} landing={landing} kind={kindLink} setup={atTop ? await assessSetupFor(user.id, current, outcome) : undefined} security={localAuthConfig() !== undefined} />;
}

/** The address of a place reached by its path: `/d/<id>` for a Doc whose id was read at the blob the repository has now, else `/f/<handle>`. */
async function addressOf(connectionId: number, path: string, blob: string | undefined): Promise<string> {
  const database = await getDatabase();
  const read = blob === undefined ? undefined : await new DocIndex(database).at(connectionId, path);
  if (read?.docId && read.blob === blob) return `/d/${read.docId}`;
  return `/f/${await new FileHandles(database).forPath(connectionId, path)}`;
}

/** A vault's own directory and every folder in it, repository-relative (a repository too large to list names none beyond the top). */
function foldersOf(vault: VaultListing): string[] {
  const folders = new Set<string>();
  for (const file of vault.files) {
    const segments = file.path.split("/").slice(0, -1);
    for (let i = 2; i <= segments.length; i++) folders.add(segments.slice(0, i).join("/"));
  }
  return [vault.directory, ...[...folders].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1))];
}

/**
 * The folders a file can be moved to in another vault when one of the two is encrypted (ROADMAP 2b.6): every other vault this version writes, except that a plaintext
 * file does not go to another plaintext vault (that is Move). The recipients the page encrypts to are asked for when a vault is chosen, not read for every page.
 */
function transferTargetsFor(read: RepositoryRead, source: VaultListing): TransferTarget[] {
  const targets: TransferTarget[] = [];
  for (const vault of read.discovery.vaults) {
    if (vault.directory === source.directory || vault.manifestError !== null) continue;
    if (vault.encrypted === true) {
      const written = checkEncryptedVault(read.discovery.vaults, read.manifests, vault.directory);
      if (!written.ok) continue;
      const to = { form: "encrypted" as const, naming: written.target.naming };
      for (const folder of foldersOf(vault)) targets.push({ folder, vault: vault.directory, to });
    } else if (vault.encrypted === false && vault.fileNaming === "plain" && source.encrypted === true) {
      for (const folder of foldersOf(vault)) targets.push({ folder, vault: vault.directory, to: { form: "plaintext" } });
    }
  }
  return targets.slice(0, 300);
}

/**
 * The folders a file or folder can be moved to (ROADMAP 1b.11): the top of every plaintext vault with plain names, and every
 * folder in them, repository-relative. A repository too large to list names no folders, so none is offered there; the top
 * of each vault still is. At most 300, the vault tops first.
 */
function moveDestinations(read: RepositoryRead, only?: string): string[] {
  const tops: string[] = [];
  const folders = new Set<string>();
  for (const vault of read.discovery.vaults) {
    // A file of an encrypted vault stays in it: its own folders are all it can go to.
    if (only !== undefined ? vault.directory !== only : vault.manifestError !== null || vault.encrypted !== false || vault.fileNaming !== "plain") continue;
    tops.push(vault.directory);
    for (const file of vault.files) {
      const segments = file.path.split("/").slice(0, -1);
      for (let i = 2; i <= segments.length; i++) folders.add(segments.slice(0, i).join("/"));
    }
  }
  return [...tops, ...[...folders].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : 1))].slice(0, 300);
}
