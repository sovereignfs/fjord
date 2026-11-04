import { notFound, redirect } from "next/navigation";
import { requireSession } from "../../auth/server";
import { safeSegments } from "../location";
import { entryFor } from "../../kinds/entry";
import { journalTagsFor } from "../../journal/server";
import { FolderView } from "../screens/FolderView";
import { assessSetupFor, findDocIdIn, locateInRepository, readConnection, readNoteFor, recordFileRead } from "../server";
import { type Address, vaultAddress } from "../addresses";
import type { Location } from "../location";
import { addressBookFor } from "../address-book";
import { repositoryHref } from "../links";
import { isPublicId } from "../../connections/public-id";
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
 * One of the account's own repositories (`/repo/<repo>`, its public id), and a place inside it: `/repo/<repo>/<vault>/<folders…>`
 * is a folder, and down to a file's name is the file (ROADMAP 1a.11). Someone else's repository, a path that is not there and
 * one that tries to climb out are all a 404 and nothing more. `path` is the decoded segments. `/d/<id>`
 * shows a file the same way, once the id has been found (ROADMAP 1b.6).
 */
export async function RepositoryScreen({ connection, path: urlPath, address, requested, view, query = {}, via }: { connection: string; /** The path, for the old forms: `/repo/<repo>/<path…>`, a handle's, a Doc id's. */ path?: string[] | undefined; /** The place an address of ids names (`/repo/<repo>/v/<vault>/…`), which the page resolves to a path; with this, `path` is not given. */ address?: Extract<Address, { kind: "vault" | "place" | "note" }> | undefined; /** The address as it was asked for, to tell whether it is the one the place has now; if it is not the person is sent to that. */ requested?: string | undefined; /** How the page was reached: by a `handle` (`/f/<handle>`), or by an address of ids. With none (the old address by path), the place is sent on to its address of ids. */ via?: "handle" | "address" | undefined; /** `files`: show a repository of any kind as a drive (spec §3.1). */ view?: string | undefined; /** The page's query, for an entry view that pages or filters. */ query?: Record<string, string | string[] | undefined> }) {
  const { user } = await requireSession();
  if (!isPublicId(connection) || encryptionKeyring() === undefined) notFound();
  const connections = await (await connectionService()).list(user.id);
  const current = connections.find((c) => c.publicId === connection);
  if (!current) notFound();

  const outcome = await readConnection(user.id, current);
  // An address of ids is a path once it is resolved: the vault by its manifest's id, a folder or a file by its handle, a Doc by its `id`. The last id says what is shown.
  let path = urlPath;
  if (address !== undefined && outcome.ok) {
    if (address.kind === "vault") {
      const vault = outcome.read.discovery.vaults.find((candidate) => candidate.id === address.vault);
      if (!vault) notFound();
      path = [vault.directory];
    } else if (address.kind === "note" && "doc" in address.target) {
      const found = await findDocIdIn(user.id, current, outcome.read, address.target.doc);
      if (found === undefined) notFound();
      path = found.split("/");
    } else if (address.kind === "note" || "handle" in address.target || "html" in address.target) {
      const target = address.target as { handle: string } | { html: string };
      const place = await new FileHandles(await getDatabase()).resolve("html" in target ? target.html : target.handle);
      // Another repository's handle is nothing here.
      if (!place || place.connectionId !== current.id) notFound();
      path = place.path.split("/");
    } else {
      const found = await findDocIdIn(user.id, current, outcome.read, address.target.doc);
      if (found === undefined) notFound();
      path = found.split("/");
    }
  }
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
      } else if (via === "handle" || via === "address") {
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
      // A note or a document in a plaintext vault is shown in its editor; reading it is the only thing that touches the file.
      const file = found.location.kind === "file" ? found.location.file : undefined;
      const note = file?.kind === "doc" ? await readNoteFor(user.id, current, outcome.read, file.path) : undefined;
      // Reading it tells which Doc it is, which is how `/d/<id>` finds it later (ROADMAP 1b.6).
      if (file !== undefined && note?.ok) await recordFileRead(current.id, file, note.blob, note.text);
      const docId = file !== undefined && note?.ok ? docIdOf(fjord(), note.text) : null;
      const permalink = file !== undefined && docId !== null ? `/d/${docId}` : undefined;
      // The place is at one address (workstream 0003): its vault, the folder it is in and its own id, or for a Doc its `id`. Reached any other way (the old address by
      // path, a handle's, one whose vault or folder is not where it is now) the person is sent there. The one place that shows a path is the file picked from among several
      // that claim one `id`, where an address by id cannot say which.
      if (!(via === undefined && query.pick === "1")) {
        const place = segments.join("/");
        const book = await addressBookFor(current, found.location.vault, [place]);
        // A static HTML page of a plaintext vault is at its own `html` address, where it is shown in a sandbox.
        // A journal's entries are notes (`/repo/<repo>/n/<id>`, by handle when the id is in the ciphertext) and a site's are posts (`/repo/<repo>/post/<id>`); a drive's Docs are where they are.
        const as = outcome.ok && outcome.read.manifest?.ok === true ? (outcome.read.manifest.kind === "journal" ? "n" : outcome.read.manifest.kind === "ssg" ? "post" : undefined) : undefined;
        const target = file !== undefined && as !== undefined && (file.kind === "doc" || file.kind === "payload") ? book.noteHref(place, docId, as) : docId !== null && file !== undefined ? book.docHref(place, docId) : isHtmlPage(found.location) ? book.htmlHref(place) : book.href(place);
        if (target !== (requested ?? "")) redirect(target);
      }
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
      content = <FolderView html={isHtmlPage(found.location) ? { src: `/raw/${current.publicId}/${await new FileHandles(await getDatabase()).forPath(current.id, segments.join("/"))}` } : undefined} tagSuggestions={tagSuggestions} connectionId={current.id} repo={current.publicId} repository={`${current.owner}/${current.name}`} location={found.location} note={note} draft={draft} preview={preview} fileBlob={fileBlob} encryptedEditing={encryptedEditing} encryptedCreate={encryptedCreate} folderFiles={folderFiles} header={header} permalink={permalink} docId={file?.kind === "doc" ? (docId ?? undefined) : undefined} editor={kindFor(outcome.read.manifest).editor} writing={kindFor(outcome.read.manifest).writingView} site={kindFor(outcome.read.manifest).contentModel.fields.includes("draft")} destinations={moveDestinations(outcome.read, encryptedNaming ? found.location.vault.directory : undefined)} encryptedNaming={encryptedNaming} transferTargets={transferTargets} />;
    }
  }

  // What it opens on is its kind's (RFC 0001), or its files when asked: every kind can be shown as a drive.
  const atTop = content === undefined && (path === undefined || path.length === 0);
  // A journal or a site shown as files is its one vault, at the vault's own address (workstream 0003); `?view=files` is sent there.
  const onlyVault = outcome.ok && outcome.read.manifest?.ok === true && outcome.read.manifest.kind !== "drive" ? outcome.read.discovery.vaults[0] : undefined;
  const filesHref = onlyVault?.id ? vaultAddress(current.publicId, onlyVault.id) : undefined;
  if (atTop && view === "files" && filesHref !== undefined) redirect(filesHref);
  const asFiles = view === "files";
  const { kind, entry } = entryFor(user.id, current, outcome, asFiles, query);
  const landing = atTop ? entry : undefined;
  const kindLink = atTop && kind.id !== "drive" ? { label: kind.label, asFiles, ...(filesHref ? { filesHref } : {}) } : undefined;
  return <RepositoryView user={user} connections={connections} current={current} outcome={outcome} content={content} landing={landing} kind={kindLink} setup={atTop ? await assessSetupFor(user.id, current, outcome) : undefined} />;
}

/** Whether a located file is a static HTML page the app can run: `.html` or `.htm` in a vault that is not encrypted (an encrypted vault's bytes are the browser's to open). */
export function isHtmlPage(location: Location): boolean {
  return location.kind === "file" && location.vault.encrypted === false && /\.html?$/i.test(location.file.path) && location.file.kind === "other";
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
