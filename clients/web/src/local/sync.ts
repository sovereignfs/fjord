import { ConnectionError } from '../connections/errors';
import {
  type ConnectionInfo,
  type ConnectionService,
  explainProviderError,
} from '../connections/service';
import { isProviderError } from '../providers/errors';
import type { Change, Provider, RepositoryRef, TreeEntry } from '../providers/types';
import { gitBlobId } from '../providers/git-id';
import { repositoryKey } from '../providers/types';

/**
 * Moving a repository from this server to a git repository (ROADMAP 3i, DESIGN.md §7a): the person gives a GitHub repository and a token (as
 * connecting one does), the files are committed to it, and only when it holds them is the connection switched to it and the server's copy
 * deleted.
 *
 * **What it does to what is there.** The files are added **alongside** what the repository has, in **one import commit** on its default
 * branch's head, never forced. A path the repository already has with different content is a clash, and then nothing is written and the
 * paths are named (`would_overwrite`): Fjord never overwrites a file of an existing repository, and a person who wants that does it with git.
 * A file that is already there with the same content is not a clash (it is what a retry finds). `.gitattributes` is the one file that is
 * merged: if both have one, the lines of ours that the repository's lacks are added to its end (spec §9's merge guard must be there), and
 * nothing of its own is changed.
 *
 * **The order is what makes it safe**, and each step is safe to run again:
 *  1. the token and the repository are checked, as connecting does;
 *  2. the local files are read, at the head they are at;
 *  3. clashes are looked for, and if there are any nothing is written;
 *  4. one commit adds the files, on the head that was read (`head_moved` if anything landed: nothing is written, try again). If every
 *     file is there already (a run that stopped after this step) there is nothing to commit;
 *  5. **the repository is read again and every file is checked to be there, with the content it has here** (blob ids are git's, so this is
 *     exact). If not, nothing is deleted;
 *  6. only then the server's branch is frozen if nothing was committed to it since step 2, the connection is switched, and the server's
 *     copy is deleted (`ConnectionService.finishSync`). An edit made in the meantime is refused, not lost, and a run that finds it moved
 *     can be run again: it imports the new content too.
 * A copy is never deleted before the git repository has been seen to hold the files.
 */
export interface SyncInput {
  repository: string;
  token: string;
}

export interface SyncResult {
  connection: ConnectionInfo;
  /** The commit of the import, or the repository's head if the files were all there already. */
  commit: string;
  /** How many files were added, and how many were there already with the same content. */
  added: number;
  already: number;
}

/** What the person is shown of a clash: the first few paths. */
const CLASHES_SHOWN = 8;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_GITATTRIBUTES_BYTES = 64 * 1024;

export async function syncToGitHub(
  service: ConnectionService,
  accountId: string,
  id: number,
  input: SyncInput,
): Promise<SyncResult> {
  const connection = await service.get(accountId, id);
  if (!connection) throw new ConnectionError('not_found', 'That repository is not connected.');
  if (connection.provider !== 'local')
    throw new ConnectionError(
      'not_local',
      'This repository is already in git: there is nothing on the server to move.',
    );

  const target = await service.checkTarget(accountId, input);
  const local = service.localProvider(accountId);
  const from: RepositoryRef = { owner: connection.owner, name: connection.name };

  // 2. What is here, at the head it is at.
  const localHead = await local.getHead(from, connection.branch);
  if (!localHead.changed) throw new Error('a head was asked for without an etag');
  const expected = localHead.head.commit;
  const tree = await local.getTree(from, expected);
  const files = tree.entries.filter((entry) => entry.kind === 'file');

  // 3. What is there.
  const remote = await readRemote(target.provider, target.ref, target.head);
  const plan = await planImport(local, from, target.provider, target.ref, files, remote);

  // 4. One commit, if there is anything to add.
  let commit = target.head;
  if (plan.changes.length > 0) {
    try {
      commit = (
        await target.provider.commit(target.ref, {
          branch: target.branch,
          expectedHead: target.head,
          message: importMessage(connection.name, plan.changes.length, plan.already),
          changes: plan.changes.map((change) => change.change),
        })
      ).commit;
    } catch (error) {
      if (isProviderError(error, 'head_moved'))
        throw new ConnectionError(
          'head_moved',
          `${repositoryKey(target.ref)} changed while its files were being copied to it. Nothing was lost: try again.`,
        );
      if (isProviderError(error, 'forbidden'))
        throw new ConnectionError(
          'read_only',
          'That token cannot write to this repository, so the files were not copied. Create it with the repository permission “Contents: Read and write”.',
        );
      throw explainProviderError(error, target.ref);
    }
  }

  // 5. Is every file there, as it is here? The deletion never happens without this.
  await verify(target.provider, target.ref, commit, plan.expected);

  // 6. Now, and only now, the connection moves and the server lets go.
  const done = await service.finishSync(
    accountId,
    id,
    { ref: target.ref, branch: target.branch, token: target.token },
    expected,
  );
  return { connection: done, commit, added: plan.changes.length, already: plan.already };
}

interface PlannedChange {
  path: string;
  change: Change;
}

interface Remote {
  entries: TreeEntry[];
  byPath: Map<string, TreeEntry>;
  /** Lower-case, for the case rule of spec §5. */
  byLower: Map<string, TreeEntry>;
}

async function readRemote(provider: Provider, ref: RepositoryRef, commit: string): Promise<Remote> {
  let tree;
  try {
    tree = await provider.getTree(ref, commit);
  } catch (error) {
    throw explainProviderError(error, ref);
  }
  if (!tree.complete) {
    throw new ConnectionError(
      'unavailable',
      `${repositoryKey(ref)} is too large to check for clashes before copying into it, so nothing was copied. Create a new, smaller repository for these files.`,
    );
  }
  return {
    entries: tree.entries,
    byPath: new Map(tree.entries.map((entry) => [entry.path, entry])),
    byLower: new Map(tree.entries.map((entry) => [entry.path.toLowerCase(), entry])),
  };
}

/**
 * What to commit, what the repository must hold afterwards (`expected`: path to blob id), and how many files were there already. Throws
 * `would_overwrite` naming the paths that clash, having changed nothing.
 */
async function planImport(
  local: Provider,
  from: RepositoryRef,
  remoteProvider: Provider,
  to: RepositoryRef,
  files: TreeEntry[],
  remote: Remote,
): Promise<{ changes: PlannedChange[]; expected: Map<string, string>; already: number }> {
  const changes: PlannedChange[] = [];
  const expected = new Map<string, string>();
  const clashes: string[] = [];
  let already = 0;

  for (const file of files) {
    const there = remote.byPath.get(file.path);
    if (file.path === '.gitattributes' && there?.kind === 'file') {
      const merged = await mergeGitattributes(local, from, remoteProvider, to, file, there);
      if (merged === null) {
        expected.set(file.path, there.id);
        already++;
      } else {
        const bytes = new TextEncoder().encode(merged);
        changes.push({ path: file.path, change: { path: file.path, content: bytes } });
        expected.set(file.path, gitBlobId(bytes));
      }
      continue;
    }
    if (there) {
      if (there.kind === 'file' && there.id === file.id) {
        already++;
        expected.set(file.path, file.id);
      } else {
        clashes.push(file.path);
      }
      continue;
    }
    // A name that differs only by case (spec §5), a folder where a file goes, or a file where a folder goes.
    const lower = remote.byLower.get(file.path.toLowerCase());
    if (lower) {
      clashes.push(file.path);
      continue;
    }
    const parts = file.path.split('/');
    const blocking = parts
      .slice(0, -1)
      .some((_, i) => remote.byPath.get(parts.slice(0, i + 1).join('/'))?.kind === 'file');
    if (blocking) {
      clashes.push(file.path);
      continue;
    }
    const bytes = await local.readBlob(from, file.id, { maxBytes: MAX_FILE_BYTES });
    changes.push({
      path: file.path,
      change: { path: file.path, content: bytes, ...(file.executable ? { executable: true } : {}) },
    });
    expected.set(file.path, file.id);
  }

  if (clashes.length > 0) {
    const shown = clashes.slice(0, CLASHES_SHOWN).join(', ');
    const more =
      clashes.length > CLASHES_SHOWN ? ` and ${clashes.length - CLASHES_SHOWN} more` : '';
    throw new ConnectionError(
      'would_overwrite',
      `${repositoryKey(to)} already has ${clashes.length === 1 ? 'a file' : 'files'} where these would go: ${shown}${more}. Fjord does not overwrite a repository's files, so nothing was copied. Use an empty repository, or one with no files by these names.`,
    );
  }
  return { changes, expected, already };
}

/** The repository's `.gitattributes` with the lines of ours it lacks added at the end; null if it has them all. */
async function mergeGitattributes(
  local: Provider,
  from: RepositoryRef,
  remoteProvider: Provider,
  to: RepositoryRef,
  ours: TreeEntry,
  theirs: TreeEntry,
): Promise<string | null> {
  let remoteText: string;
  try {
    remoteText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await remoteProvider.readBlob(to, theirs.id, { maxBytes: MAX_GITATTRIBUTES_BYTES }),
    );
  } catch (error) {
    if (isProviderError(error, 'too_large') || error instanceof TypeError) {
      throw new ConnectionError(
        'gitattributes_unreadable',
        `${repositoryKey(to)}'s .gitattributes cannot be read (it is too large, or is not text), so a line cannot be added to it. Nothing was copied.`,
      );
    }
    throw explainProviderError(error, to);
  }
  const ourText = new TextDecoder().decode(
    await local.readBlob(from, ours.id, { maxBytes: MAX_GITATTRIBUTES_BYTES }),
  );
  const have = new Set(remoteText.split(/\r?\n/).map((line) => line.trim()));
  const missing = ourText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !have.has(line.trim()));
  if (missing.length === 0) return null;
  const separator = remoteText === '' || remoteText.endsWith('\n') ? '' : '\n';
  return `${remoteText}${separator}${missing.join('\n')}\n`;
}

/** Every file is in the repository at `commit` with the blob id it was meant to have. */
async function verify(
  provider: Provider,
  ref: RepositoryRef,
  commit: string,
  expected: Map<string, string>,
): Promise<void> {
  const failed = () =>
    new ConnectionError(
      'not_verified',
      `${repositoryKey(ref)} could not be read back with all the files in it, so nothing was deleted from this server. Try again.`,
    );
  let tree;
  try {
    tree = await provider.getTree(ref, commit);
  } catch {
    throw failed();
  }
  if (!tree.complete) {
    // A repository too large to list whole: ask for each file's directory, which is how the app reads one that large.
    const wanted = new Set<string>();
    for (const path of expected.keys())
      wanted.add(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    const seen = new Map<string, string>();
    for (const directory of wanted) {
      try {
        for (const entry of await provider.listDirectory(ref, commit, directory))
          if (entry.kind === 'file') seen.set(entry.path, entry.id);
      } catch {
        throw failed();
      }
    }
    for (const [path, blob] of expected) if (seen.get(path) !== blob) throw failed();
    return;
  }
  const have = new Map(
    tree.entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry.id]),
  );
  for (const [path, blob] of expected) if (have.get(path) !== blob) throw failed();
}

function importMessage(name: string, added: number, already: number): string {
  return [
    `Import “${name}” from Fjord Web`,
    '',
    `Adds ${added} ${added === 1 ? 'file' : 'files'} that were kept on the server until this repository was connected${already > 0 ? `; ${already} more ${already === 1 ? 'was' : 'were'} here already, unchanged` : ''}. Nothing that was here is changed or removed.`,
    "All of it is one commit: this repository's history before it is untouched.",
  ].join('\n');
}
