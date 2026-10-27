import { notFound } from "next/navigation";
import { localAuthConfig, requireSession } from "../../../../src/auth/server";
import { decodeSegments } from "../../../../src/browse/links";
import { safeSegments } from "../../../../src/browse/location";
import { Landing } from "../../../../src/browse/screens/Landing";
import { FolderView } from "../../../../src/browse/screens/FolderView";
import { assessSetupFor, locateInRepository, readConnection, readNoteFor } from "../../../../src/browse/server";
import { RepositoryView } from "../../../../src/connections/screens/RepositoryView";
import { connectionService } from "../../../../src/connections/server";
import { encryptionKeyring } from "../../../../src/crypto/server";
import { Alert } from "../../../../src/ui";
import { previewCombineFor, workingCopyService } from "../../../../src/working/server";
import { DeletedUpstream } from "../../../../src/browse/screens/DeletedUpstream";

export const dynamic = "force-dynamic";
export const metadata = { title: "Repository" };

/**
 * One of the account's own repositories (`/repo/<connection>`), and a place inside it: `/repo/<connection>/<vault>/<folders…>`
 * is a folder, and down to a file's name is the file (ROADMAP 1a.11). Someone else's repository, a path that is not there and
 * one that tries to climb out are all a 404 and nothing more.
 */
export default async function RepositoryPage({ params }: { params: Promise<{ connection: string; path?: string[] }> }) {
  const { user } = await requireSession();
  const { connection, path } = await params;
  if (!/^[1-9][0-9]{0,15}$/.test(connection) || encryptionKeyring() === undefined) notFound();
  const connections = await (await connectionService()).list(user.id);
  const current = connections.find((c) => c.id === Number(connection));
  if (!current) notFound();

  const outcome = await readConnection(user.id, current);
  const decoded = decodeSegments(path);
  const segments = decoded === undefined ? undefined : safeSegments(decoded);
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
      // A note in a plaintext vault is shown in the note editor; reading it is the only thing that touches the file.
      const file = found.location.kind === "file" ? found.location.file : undefined;
      const note = file?.kind === "note" ? await readNoteFor(user.id, current, outcome.read, file.path) : undefined;
      // What was typed here and not yet saved as a version: kept by the server (ROADMAP 1b.8), and found again here.
      const kept = file !== undefined && note?.ok ? await (await workingCopyService()).get(current.id, file.path) : undefined;
      const draft = kept ? { content: kept.content, baseBlob: kept.baseBlob } : null;
      // Edited here while someone changed the note from elsewhere (ROADMAP 1b.10): can the two be combined?
      const preview = kept && note?.ok && kept.baseBlob !== note.blob ? await previewCombineFor(user.id, current.id, kept, note.text) : undefined;
      content = <FolderView connectionId={current.id} repository={`${current.owner}/${current.name}`} location={found.location} note={note} draft={draft} preview={preview} />;
    }
  }

  const landing = content === undefined && (path === undefined || path.length === 0) ? <Landing accountId={user.id} connection={current} outcome={outcome} /> : undefined;
  return <RepositoryView user={user} connections={connections} current={current} outcome={outcome} content={content} landing={landing} setup={landing ? await assessSetupFor(user.id, current, outcome) : undefined} security={localAuthConfig() !== undefined} />;
}
