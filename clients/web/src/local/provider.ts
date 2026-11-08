import { createHash, randomBytes } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';
import { summarise } from '../providers/build-status';
import { ProviderError } from '../providers/errors';
import { gitBlobId } from '../providers/git-id';
import type {
  Branch,
  BuildStatus,
  CommitRequest,
  CommitResult,
  EntryKind,
  FileVersion,
  HeadResult,
  Provider,
  Repository,
  RepositoryRef,
  Tree,
  TreeEntry,
} from '../providers/types';
import { validateCommitRequest } from '../providers/validate';
import { type LimitKind, type LocalLimits, limitMessage } from './limits';

/**
 * A git host that is this server's database (ROADMAP 3i, DESIGN.md §7a): the `Provider` for a repository that was made here and is not
 * connected to git yet. Everything above it (browsing, creating, editing, moving, deleting, versions, the kinds' screens) speaks the
 * interface and is none the wiser; what it commits is kept in `local_*` tables until a sync (`sync.ts`) moves the files to a git host and
 * deletes them. It passes `providerContract`, the same cases GitHub's provider and the in-memory one do.
 *
 * It is made **for one account** and only ever sees that account's repositories: a repository of another account is "not found".
 * Content is addressed as git does it (a blob's id is git's), so that moving the files to a git host changes no id a draft, a share or a
 * published page was made against.
 *
 * **The limits are enforced here, on the one place that writes** (`commit`, and the repository's first commit): the account's files and
 * bytes can only grow within `LocalLimits`, and a commit that makes them smaller is never refused. What a limit counts is what the branches
 * hold now. A file that was deleted or replaced stays for the restore window, so that Undo and Recently deleted work, but never so much
 * that the account holds more than its byte limit again as history: the oldest of it goes first. A commit is never forced and never
 * retried, and the branch moves only if it is still where the caller read it (one statement, so it holds across processes).
 */
export const LOCAL_OWNER = 'local';
/** The branch a server-side repository starts with. */
export const LOCAL_BRANCH = 'main';
/** How many commits before a head are kept, so that a tree read a moment ago can still be read. */
const COMMITS_KEPT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK = 400;

export interface LocalProviderOptions {
  database: Database;
  /** Whose repositories these are: no other account's is reachable through this provider. */
  accountId: string;
  limits: LocalLimits;
  /** How long a deleted file's content is kept for putting back, in milliseconds. */
  restoreWindowMs?: number;
  /** For tests. */
  now?: () => number;
}

interface RepositoryRow {
  id: number;
  name: string;
  defaultBranch: string;
  fileCount: number;
  liveBytes: number;
  retiredBytes: number;
}

/** A file as a commit holds it. */
interface TreeFile {
  path: string;
  blob: string;
  executable: boolean;
  size: number;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

export const tables = (database: Database) =>
  database.dialect === 'postgres'
    ? {
        repository: postgresSchema.localRepository,
        branch: postgresSchema.localBranch,
        commit: postgresSchema.localCommit,
        blob: postgresSchema.localBlob,
      }
    : {
        repository: sqliteSchema.localRepository,
        branch: sqliteSchema.localBranch,
        commit: sqliteSchema.localCommit,
        blob: sqliteSchema.localBlob,
      };

const encodeTree = (files: TreeFile[]): string =>
  JSON.stringify(files.map((file) => [file.path, file.blob, file.executable ? 1 : 0, file.size]));

function decodeTree(text: string): TreeFile[] {
  const rows = JSON.parse(text) as [string, string, number, number][];
  return rows.map(([path, blob, executable, size]) => ({
    path,
    blob,
    executable: executable === 1,
    size,
  }));
}

const idList = (ids: string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const reported = (kind: LimitKind, limits: LocalLimits) =>
  new ProviderError('limit_reached', limitMessage(kind, limits), { limit: kind });

/** Whether a repository name is one a person can be given: something to call it, nothing that breaks a path or a line. */
export function validRepositoryName(name: string): boolean {
  return (
    name === name.trim() &&
    name.length >= 1 &&
    name.length <= 64 &&
    !/[\u0000-\u001f\u007f/\\]/.test(name) &&
    !name.startsWith('.')
  );
}

export class LocalProvider implements Provider {
  readonly name = 'local';
  readonly webhooks = false;
  private readonly database: Database;
  private readonly accountId: string;
  private readonly limits: LocalLimits;
  private readonly restoreWindowMs: number;
  private readonly now: () => number;
  private treeLimit: number | undefined;

  constructor(options: LocalProviderOptions) {
    this.database = options.database;
    this.accountId = options.accountId;
    this.limits = options.limits;
    this.restoreWindowMs = options.restoreWindowMs ?? 30 * DAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** Cut `getTree` short past this many entries, as a host does for a very large repository (for the contract's test of it). */
  setTreeLimit(limit: number | undefined): void {
    this.treeLimit = limit;
  }

  // --- Making one (not part of Provider) ----------------------------------------------------

  /**
   * A new repository with `files` as its first commit (an empty tree is allowed: a repository that is not set up yet). Refused with
   * `limit_reached` when the account already has as many repositories as it may, or the files do not fit; `branch_exists` is not it:
   * a name that is taken is `invalid_request`.
   */
  async create(
    name: string,
    files: Record<string, Uint8Array>,
    options: { message?: string } = {},
  ): Promise<RepositoryRef> {
    if (!validRepositoryName(name))
      throw new ProviderError('invalid_request', 'that is not a name a repository can have');
    const t = tables(this.database);
    if (this.limits.repositories === 0) throw reported('repositories', this.limits);
    const mine = await dbAll<RepositoryRow & { name: string }>(
      this.database,
      sql`SELECT ${REPOSITORY_COLUMNS} FROM ${t.repository} WHERE account_id = ${this.accountId}`,
    );
    if (mine.length >= this.limits.repositories) throw reported('repositories', this.limits);
    if (mine.some((row) => row.name.toLowerCase() === name.toLowerCase()))
      throw new ProviderError('invalid_request', `you already have a repository called “${name}”`);

    const tree: TreeFile[] = [];
    const contents = new Map<string, Uint8Array>();
    for (const [path, content] of Object.entries(files)) {
      const blob = gitBlobId(content);
      contents.set(blob, content);
      tree.push({ path, blob, executable: false, size: content.byteLength });
    }
    const bytes = [...contents.keys()].reduce(
      (sum, blob) => sum + (contents.get(blob)?.byteLength ?? 0),
      0,
    );
    const totals = await this.totals(undefined);
    if (totals.files + tree.length > this.limits.files) throw reported('files', this.limits);
    if (totals.bytes + bytes > this.limits.bytes) throw reported('bytes', this.limits);

    const now = this.now();
    const inserted = await dbAll<{ id: number }>(
      this.database,
      sql`INSERT INTO ${t.repository} (account_id, name, default_branch, file_count, live_bytes, retired_bytes, created_at)
          VALUES (${this.accountId}, ${name}, ${LOCAL_BRANCH}, ${tree.length}, ${bytes}, 0, ${now}) RETURNING id`,
    );
    const id = Number(inserted[0]?.id);
    try {
      // Two requests that each saw room for one more: the one that finds it was over is undone, so the limit holds however they interleave.
      const counted = await dbAll<{ n: number | string }>(
        this.database,
        sql`SELECT COUNT(*) AS n FROM ${t.repository} WHERE account_id = ${this.accountId}`,
      );
      if (Number(counted[0]?.n ?? 0) > this.limits.repositories)
        throw reported('repositories', this.limits);
      for (const [blob, content] of contents) {
        await dbRun(
          this.database,
          sql`INSERT INTO ${t.blob} (repository_id, id, size, content, retired_at) VALUES (${id}, ${blob}, ${content.byteLength}, ${Buffer.from(content).toString('base64')}, NULL)`,
        );
      }
      const commit = this.commitId(undefined, options.message ?? 'Create this repository', tree);
      await dbRun(
        this.database,
        sql`INSERT INTO ${t.commit} (repository_id, id, parent_id, message, author_name, author_email, tree, created_at)
            VALUES (${id}, ${commit}, NULL, ${options.message ?? 'Create this repository'}, NULL, NULL, ${encodeTree(tree)}, ${now})`,
      );
      await dbRun(
        this.database,
        sql`INSERT INTO ${t.branch} (repository_id, name, commit_id) VALUES (${id}, ${LOCAL_BRANCH}, ${commit})`,
      );
    } catch (error) {
      // Nothing may be left of a repository that did not get made.
      await this.deleteRows(id);
      throw error;
    }
    return { owner: LOCAL_OWNER, name };
  }

  /** Every trace of one repository, as a sync or a disconnection does. Safe to run again. */
  async destroy(ref: RepositoryRef): Promise<void> {
    const row = await this.find(ref).catch(() => undefined);
    if (row) await this.deleteRows(row.id);
  }

  /**
   * Stop a branch taking commits, for a sync that is about to delete the repository (`ConnectionService.finishSync`): the branch is moved
   * to a marker that no commit is at, in one statement that checks it is still at `expected`. False if it was not (something was committed
   * since the files were read), and then nothing changed. Every commit after it is `head_moved`.
   */
  async freeze(ref: RepositoryRef, branch: string, expected: string): Promise<boolean> {
    const repo = await this.find(ref);
    const moved = await dbAll<{ name: string }>(
      this.database,
      sql`UPDATE ${tables(this.database).branch} SET commit_id = ${`frozen:${expected}`} WHERE repository_id = ${repo.id} AND name = ${branch} AND commit_id = ${expected} RETURNING name`,
    );
    return moved.length > 0;
  }

  /** Undo `freeze`, when the sync could not go on. */
  async thaw(ref: RepositoryRef, branch: string, expected: string): Promise<void> {
    const repo = await this.find(ref);
    await dbRun(
      this.database,
      sql`UPDATE ${tables(this.database).branch} SET commit_id = ${expected} WHERE repository_id = ${repo.id} AND name = ${branch} AND commit_id = ${`frozen:${expected}`}`,
    );
  }

  /** Every server-side repository this account has, with its files: for an account that is being deleted (`src/sovereign/people.ts`). Safe to run again. */
  async destroyAll(): Promise<void> {
    const rows = await dbAll<{ id: number }>(
      this.database,
      sql`SELECT id FROM ${tables(this.database).repository} WHERE account_id = ${this.accountId}`,
    );
    for (const row of rows) await this.deleteRows(Number(row.id));
  }

  /** What this account holds, over all its repositories. */
  async usage(): Promise<{ repositories: number; files: number; bytes: number }> {
    const totals = await this.totals(undefined);
    const rows = await dbAll<{ n: number | string }>(
      this.database,
      sql`SELECT COUNT(*) AS n FROM ${tables(this.database).repository} WHERE account_id = ${this.accountId}`,
    );
    return { repositories: Number(rows[0]?.n ?? 0), ...totals };
  }

  // --- Provider ------------------------------------------------------------------------------

  async listRepositories(): Promise<Repository[]> {
    const rows = await dbAll<RepositoryRow>(
      this.database,
      sql`SELECT ${REPOSITORY_COLUMNS} FROM ${tables(this.database).repository} WHERE account_id = ${this.accountId} ORDER BY id ASC`,
    );
    return rows.map((row) => this.describe(row));
  }

  async getRepository(ref: RepositoryRef): Promise<Repository> {
    return this.describe(await this.find(ref));
  }

  async getHead(
    ref: RepositoryRef,
    branch: string,
    options: { etag?: string | undefined } = {},
  ): Promise<HeadResult> {
    const repo = await this.find(ref);
    const commit = await this.headOf(repo, branch);
    if (!commit) throw new ProviderError('not_found', `there is no branch "${branch}"`);
    const etag = `"${commit}"`;
    if (options.etag === etag) return { changed: false };
    return { changed: true, head: { branch, commit, etag } };
  }

  async getTree(ref: RepositoryRef, commit: string): Promise<Tree> {
    const repo = await this.find(ref);
    const entries = entriesOf(await this.treeOf(repo, commit), commit);
    if (this.treeLimit !== undefined && entries.length > this.treeLimit)
      return { commit, entries: entries.slice(0, this.treeLimit), complete: false };
    return { commit, entries, complete: true };
  }

  async fileHistory(
    ref: RepositoryRef,
    commit: string,
    path: string,
    limit: number,
  ): Promise<FileVersion[]> {
    const repo = await this.find(ref);
    const { commit: commits } = tables(this.database);
    const read = (id: string) =>
      dbGet<{
        id: string;
        parentId: string | null;
        message: string;
        author: string | null;
        createdAt: number;
        tree: string;
      }>(
        this.database,
        sql`SELECT id, parent_id AS "parentId", message, author_name AS author, created_at AS "createdAt", tree FROM ${commits} WHERE repository_id = ${repo.id} AND id = ${id}`,
      );
    const blobIn = (tree: string) => decodeTree(tree).find((file) => file.path === path)?.blob;
    const versions: FileVersion[] = [];
    let row = await read(commit);
    if (!row) throw new ProviderError('not_found', `there is no commit ${commit.slice(0, 7)}`);
    // Each commit against the one before it. A parent that has gone (old history is let go of, within the limits) ends it: what is known is told.
    while (row && versions.length < limit) {
      const parent: typeof row | undefined = row.parentId ? await read(row.parentId) : undefined;
      const here = blobIn(row.tree);
      if (here !== undefined && here !== (parent ? blobIn(parent.tree) : undefined))
        versions.push({
          commit: row.id,
          message: row.message.split('\n')[0] as string,
          author: row.author,
          date: new Date(Number(row.createdAt)).toISOString(),
        });
      row = parent;
    }
    return versions;
  }

  async listDirectory(ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry[]> {
    const repo = await this.find(ref);
    const entries = entriesOf(await this.treeOf(repo, commit), commit);
    if (
      path !== '' &&
      !entries.some((entry) => entry.path === path && entry.kind === 'directory')
    ) {
      throw new ProviderError('not_found', `there is no directory "${path}" in that commit`);
    }
    const prefix = path === '' ? '' : `${path}/`;
    return entries.filter(
      (entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'),
    );
  }

  async readBlob(
    ref: RepositoryRef,
    blob: string,
    options: { maxBytes?: number | undefined } = {},
  ): Promise<Uint8Array> {
    const repo = await this.find(ref);
    const row = await dbGet<{ size: number; content: string }>(
      this.database,
      sql`SELECT size, content FROM ${tables(this.database).blob} WHERE repository_id = ${repo.id} AND id = ${blob}`,
    );
    if (!row) throw new ProviderError('not_found', 'there is no such file');
    if (options.maxBytes !== undefined && Number(row.size) > options.maxBytes) {
      throw new ProviderError(
        'too_large',
        `the file is ${Number(row.size)} bytes, over the limit of ${options.maxBytes}`,
      );
    }
    return new Uint8Array(Buffer.from(row.content, 'base64'));
  }

  async commit(ref: RepositoryRef, request: CommitRequest): Promise<CommitResult> {
    validateCommitRequest(request);
    const t = tables(this.database);
    const repo = await this.find(ref);
    const head = await this.headOf(repo, request.branch);
    if (!head) throw new ProviderError('not_found', `there is no branch "${request.branch}"`);
    // The same rule as a fast-forward: only if the branch is still where the caller read it.
    if (head !== request.expectedHead)
      throw new ProviderError(
        'head_moved',
        `${request.branch} has moved on from ${request.expectedHead.slice(0, 7)}`,
      );

    const before = await this.treeOf(repo, head);
    const next = new Map(before.map((file) => [file.path, file]));
    const added = new Map<string, Uint8Array>();
    for (const change of request.changes) {
      if ('delete' in change) {
        next.delete(change.path);
      } else if ('blob' in change) {
        const known = await dbGet<{ size: number }>(
          this.database,
          sql`SELECT size FROM ${t.blob} WHERE repository_id = ${repo.id} AND id = ${change.blob}`,
        );
        if (!known)
          throw new ProviderError(
            'invalid_request',
            `there is no blob ${change.blob.slice(0, 7)} to put at "${change.path}"`,
          );
        next.set(change.path, {
          path: change.path,
          blob: change.blob,
          executable: change.executable ?? false,
          size: Number(known.size),
        });
      } else {
        const blob = gitBlobId(change.content);
        added.set(blob, change.content);
        next.set(change.path, {
          path: change.path,
          blob,
          executable: change.executable ?? false,
          size: change.content.byteLength,
        });
      }
    }
    const after = [...next.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    if (sameTree(before, after))
      throw new ProviderError('no_changes', 'the commit would not change anything');

    // What the repository would hold: the new tree and every other branch's head, each blob once.
    const live = new Map<string, number>(after.map((file) => [file.blob, file.size]));
    for (const other of await this.heads(repo)) {
      if (other.name === request.branch) continue;
      for (const file of await this.treeOf(repo, other.commitId)) live.set(file.blob, file.size);
    }
    const liveBytes = [...live.values()].reduce((sum, size) => sum + size, 0);
    // A limit only ever refuses a commit that makes the account hold more: one that deletes is always let through.
    const others = await this.totals(repo.id);
    if (after.length > repo.fileCount && others.files + after.length > this.limits.files)
      throw reported('files', this.limits);
    if (liveBytes > repo.liveBytes && others.bytes + liveBytes > this.limits.bytes)
      throw reported('bytes', this.limits);

    const now = this.now();
    for (const [blob, content] of added) {
      await dbRun(
        this.database,
        sql`INSERT INTO ${t.blob} (repository_id, id, size, content, retired_at) VALUES (${repo.id}, ${blob}, ${content.byteLength}, ${Buffer.from(content).toString('base64')}, NULL)
            ON CONFLICT (repository_id, id) DO NOTHING`,
      );
    }
    const commit = this.commitId(head, request.message, after);
    await dbRun(
      this.database,
      sql`INSERT INTO ${t.commit} (repository_id, id, parent_id, message, author_name, author_email, tree, created_at)
          VALUES (${repo.id}, ${commit}, ${head}, ${request.message}, ${request.author?.name ?? null}, ${request.author?.email ?? null}, ${encodeTree(after)}, ${now})`,
    );
    // One statement decides it: the branch moves only if it is still where the caller read it.
    const moved = await dbAll<{ name: string }>(
      this.database,
      sql`UPDATE ${t.branch} SET commit_id = ${commit} WHERE repository_id = ${repo.id} AND name = ${request.branch} AND commit_id = ${head} RETURNING name`,
    );
    if (moved.length === 0) {
      await dbRun(
        this.database,
        sql`DELETE FROM ${t.commit} WHERE repository_id = ${repo.id} AND id = ${commit}`,
      );
      await this.settle(repo, now);
      throw new ProviderError(
        'head_moved',
        `${request.branch} has moved on from ${request.expectedHead.slice(0, 7)}`,
      );
    }
    await this.settle(repo, now);
    return { commit, parent: head, branch: request.branch };
  }

  async canWrite(ref: RepositoryRef, branch: string): Promise<boolean> {
    // The branch has to be there, as it does for a real host; this account always may write to its own.
    await this.getHead(ref, branch);
    return true;
  }

  async createBranch(ref: RepositoryRef, branch: string, fromCommit: string): Promise<void> {
    const t = tables(this.database);
    const repo = await this.find(ref);
    const known = await dbGet<{ id: string }>(
      this.database,
      sql`SELECT id FROM ${t.commit} WHERE repository_id = ${repo.id} AND id = ${fromCommit}`,
    );
    if (!known) throw new ProviderError('not_found', `there is no commit ${fromCommit}`);
    if (await this.headOf(repo, branch))
      throw new ProviderError('branch_exists', `there is already a branch ${branch}`);
    try {
      await dbRun(
        this.database,
        sql`INSERT INTO ${t.branch} (repository_id, name, commit_id) VALUES (${repo.id}, ${branch}, ${fromCommit})`,
      );
    } catch (error) {
      // A branch made at the same moment by another request: the unique index decided, and it was there first.
      if (await this.headOf(repo, branch))
        throw new ProviderError('branch_exists', `there is already a branch ${branch}`);
      throw error;
    }
    await this.settle(repo, this.now());
  }

  async deleteBranch(ref: RepositoryRef, branch: string): Promise<void> {
    const t = tables(this.database);
    const repo = await this.find(ref);
    if (branch === repo.defaultBranch)
      throw new ProviderError('invalid_request', 'the default branch is not deleted from here');
    const gone = await dbAll<{ name: string }>(
      this.database,
      sql`DELETE FROM ${t.branch} WHERE repository_id = ${repo.id} AND name = ${branch} RETURNING name`,
    );
    if (gone.length === 0) throw new ProviderError('not_found', `there is no branch ${branch}`);
    await this.settle(repo, this.now());
  }

  async listBranches(ref: RepositoryRef, prefix: string): Promise<Branch[]> {
    const repo = await this.find(ref);
    return (await this.heads(repo))
      .filter((head) => head.name.startsWith(prefix))
      .map((head) => ({ branch: head.name, commit: head.commitId }))
      .sort((a, b) => (a.branch < b.branch ? -1 : 1));
  }

  async getBuildStatus(ref: RepositoryRef, commit: string): Promise<BuildStatus> {
    const repo = await this.find(ref);
    const known = await dbGet<{ id: string }>(
      this.database,
      sql`SELECT id FROM ${tables(this.database).commit} WHERE repository_id = ${repo.id} AND id = ${commit}`,
    );
    if (!known) throw new ProviderError('not_found', `there is no commit ${commit}`);
    // Nothing builds a repository that is on this server.
    return summarise(commit, []);
  }

  // --- Internals ---------------------------------------------------------------------------

  private describe(row: RepositoryRow): Repository {
    return {
      ref: { owner: LOCAL_OWNER, name: row.name },
      defaultBranch: row.defaultBranch,
      private: true,
      canPush: true,
    };
  }

  private async find(ref: RepositoryRef): Promise<RepositoryRow> {
    const row =
      ref.owner === LOCAL_OWNER
        ? await dbGet<RepositoryRow>(
            this.database,
            sql`SELECT ${REPOSITORY_COLUMNS} FROM ${tables(this.database).repository} WHERE account_id = ${this.accountId} AND name = ${ref.name}`,
          )
        : undefined;
    if (!row)
      throw new ProviderError('not_found', `there is no repository ${ref.owner}/${ref.name}`);
    return {
      ...row,
      id: Number(row.id),
      fileCount: Number(row.fileCount),
      liveBytes: Number(row.liveBytes),
      retiredBytes: Number(row.retiredBytes),
    };
  }

  private async heads(repo: RepositoryRow): Promise<{ name: string; commitId: string }[]> {
    return dbAll<{ name: string; commitId: string }>(
      this.database,
      sql`SELECT name, commit_id AS "commitId" FROM ${tables(this.database).branch} WHERE repository_id = ${repo.id}`,
    );
  }

  private async headOf(repo: RepositoryRow, branch: string): Promise<string | undefined> {
    return (await this.heads(repo)).find((head) => head.name === branch)?.commitId;
  }

  private async treeOf(repo: RepositoryRow, commit: string): Promise<TreeFile[]> {
    const row = await dbGet<{ tree: string }>(
      this.database,
      sql`SELECT tree FROM ${tables(this.database).commit} WHERE repository_id = ${repo.id} AND id = ${commit}`,
    );
    if (!row) throw new ProviderError('not_found', `there is no commit ${commit.slice(0, 7)}`);
    return decodeTree(row.tree);
  }

  /** What the account's other repositories hold now (all of them with `undefined`). */
  private async totals(except: number | undefined): Promise<{ files: number; bytes: number }> {
    const t = tables(this.database);
    const row = await dbGet<{ files: number | string | null; bytes: number | string | null }>(
      this.database,
      except === undefined
        ? sql`SELECT SUM(file_count) AS files, SUM(live_bytes) AS bytes FROM ${t.repository} WHERE account_id = ${this.accountId}`
        : sql`SELECT SUM(file_count) AS files, SUM(live_bytes) AS bytes FROM ${t.repository} WHERE account_id = ${this.accountId} AND id <> ${except}`,
    );
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  private commitId(parent: string | undefined, message: string, tree: TreeFile[]): string {
    const listing = tree.map((file) => `${file.path}:${file.blob}:${file.executable}`).join('\n');
    return sha1(`${parent ?? ''}\n${message}\n${listing}\n${randomBytes(8).toString('hex')}`);
  }

  /**
   * After the branches changed: which blobs the branches hold (live) and which are only history (retired, with when they stopped being
   * live), history older than the restore window gone and the rest no more than the byte limit, the commits that are not a head or one of
   * the latest few gone, and the repository's counters brought up to date. It is computed from what is stored, not from what a commit
   * thought it changed, so a request that stopped half way is put right by the next.
   */
  private async settle(repo: RepositoryRow, now: number): Promise<void> {
    const t = tables(this.database);
    const heads = await this.heads(repo);
    const commits = await dbAll<{ id: string; parentId: string | null }>(
      this.database,
      sql`SELECT id, parent_id AS "parentId" FROM ${t.commit} WHERE repository_id = ${repo.id}`,
    );
    const parents = new Map(commits.map((commit) => [commit.id, commit.parentId]));

    const live = new Set<string>();
    let files = 0;
    for (const head of heads) {
      const tree = await this.treeOf(repo, head.commitId);
      if (head.name === repo.defaultBranch) files = tree.length;
      for (const file of tree) live.add(file.blob);
    }

    const blobs = await dbAll<{ id: string; size: number; retiredAt: number | null }>(
      this.database,
      sql`SELECT id, size, retired_at AS "retiredAt" FROM ${t.blob} WHERE repository_id = ${repo.id}`,
    );
    const revive = blobs
      .filter((blob) => live.has(blob.id) && blob.retiredAt !== null)
      .map((blob) => blob.id);
    const retire = blobs
      .filter((blob) => !live.has(blob.id) && blob.retiredAt === null)
      .map((blob) => blob.id);
    for (const part of chunks(revive))
      await dbRun(
        this.database,
        sql`UPDATE ${t.blob} SET retired_at = NULL WHERE repository_id = ${repo.id} AND id IN (${idList(part)})`,
      );
    for (const part of chunks(retire))
      await dbRun(
        this.database,
        sql`UPDATE ${t.blob} SET retired_at = ${now} WHERE repository_id = ${repo.id} AND id IN (${idList(part)})`,
      );

    // What is kept only as history: not past the window, and not more than the account may hold.
    let kept = blobs
      .filter((blob) => !live.has(blob.id))
      .map((blob) => ({
        id: blob.id,
        size: Number(blob.size),
        retiredAt: blob.retiredAt === null ? now : Number(blob.retiredAt),
      }))
      .sort((a, b) => a.retiredAt - b.retiredAt);
    const expired = kept.filter((blob) => blob.retiredAt < now - this.restoreWindowMs);
    kept = kept.filter((blob) => blob.retiredAt >= now - this.restoreWindowMs);
    let retiredBytes = kept.reduce((sum, blob) => sum + blob.size, 0);
    const dropped = expired.map((blob) => blob.id);
    while (retiredBytes > this.limits.bytes && kept.length > 0) {
      const oldest = kept.shift()!;
      retiredBytes -= oldest.size;
      dropped.push(oldest.id);
    }
    for (const part of chunks(dropped))
      await dbRun(
        this.database,
        sql`DELETE FROM ${t.blob} WHERE repository_id = ${repo.id} AND id IN (${idList(part)})`,
      );

    // The commits kept: every head and the few before each.
    const keep = new Set<string>();
    for (const head of heads) {
      let at: string | null | undefined = head.commitId;
      for (let depth = 0; at && depth < COMMITS_KEPT; depth++) {
        keep.add(at);
        at = parents.get(at);
      }
    }
    const goneCommits = commits.map((commit) => commit.id).filter((id) => !keep.has(id));
    for (const part of chunks(goneCommits))
      await dbRun(
        this.database,
        sql`DELETE FROM ${t.commit} WHERE repository_id = ${repo.id} AND id IN (${idList(part)})`,
      );

    const liveBytes = blobs
      .filter((blob) => live.has(blob.id))
      .reduce((sum, blob) => sum + Number(blob.size), 0);
    await dbRun(
      this.database,
      sql`UPDATE ${t.repository} SET file_count = ${files}, live_bytes = ${liveBytes}, retired_bytes = ${retiredBytes} WHERE id = ${repo.id}`,
    );
  }

  private async deleteRows(id: number): Promise<void> {
    const t = tables(this.database);
    await dbRun(this.database, sql`DELETE FROM ${t.blob} WHERE repository_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${t.commit} WHERE repository_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${t.branch} WHERE repository_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${t.repository} WHERE id = ${id}`);
  }
}

const REPOSITORY_COLUMNS = sql.raw(
  'id, name, default_branch AS "defaultBranch", file_count AS "fileCount", live_bytes AS "liveBytes", retired_bytes AS "retiredBytes"',
);

function sameTree(a: TreeFile[], b: TreeFile[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Map(b.map((file) => [file.path, file]));
  return a.every((file) => {
    const match = other.get(file.path);
    return match !== undefined && match.blob === file.blob && match.executable === file.executable;
  });
}

/** Every file and every directory of a commit, in path order. */
function entriesOf(files: TreeFile[], commit: string): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!entries.has(dir))
        entries.set(dir, {
          path: dir,
          kind: 'directory' as EntryKind,
          id: sha1(`tree:${dir}:${commit}`),
          executable: false,
        });
    }
    entries.set(file.path, {
      path: file.path,
      kind: 'file',
      id: file.blob,
      size: file.size,
      executable: file.executable,
    });
  }
  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The local repository an account's connection is of, by name, or undefined. For the connection service's checks. */
export async function localRepositoryNames(
  database: Database,
  accountId: string,
): Promise<string[]> {
  const rows = await dbAll<{ name: string }>(
    database,
    sql`SELECT name FROM ${tables(database).repository} WHERE account_id = ${accountId} ORDER BY id ASC`,
  );
  return rows.map((row) => row.name);
}
