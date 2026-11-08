import { ProviderError } from '../errors';
import type {
  Branch,
  BuildCheck,
  BuildState,
  BuildStatus,
  Change,
  CommitRequest,
  CommitResult,
  EntryKind,
  HeadResult,
  Provider,
  Repository,
  RepositoryRef,
  Tree,
  TreeEntry,
  WebhookEvent,
  WebhookRequest,
  FileVersion,
} from '../types';
import { mapLimit } from '../concurrency';
import { safeUrl, summarise } from '../build-status';
import { validateCommitRequest } from '../validate';
import { GitHubClient, type GitHubClientOptions } from './http';
import { verifyGitHubWebhook } from './webhook';

/**
 * GitHub, through its REST API and its Git Data endpoints (DESIGN.md §7). Reads go by git object
 * id; a commit is made the way git makes one (blobs, a tree on top of the head's, a commit, then a
 * fast-forward of the branch) so that it is atomic and never overwrites.
 *
 * `scope` says what `listRepositories` means: for a GitHub App's installation token, the
 * repositories the App was installed on; for a personal access token, the ones the user can reach.
 */
export interface GitHubProviderOptions extends GitHubClientOptions {
  scope: 'installation' | 'user';
  /** How many blobs are uploaded at once in a commit. */
  uploadConcurrency?: number;
}

interface GitHubRepo {
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  permissions?: { push?: boolean };
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

/** A check run's state: only a completed one has a conclusion, and a skipped or neutral one is not a failure. */
export function checkRunState(run: { status?: string; conclusion?: string | null }): BuildState {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'success';
    default:
      // failure, timed_out, cancelled, action_required, stale: nothing was built.
      return 'failure';
  }
}

/** A commit status's (and a deployment status's) state. */
export function statusState(state: string | undefined): BuildState {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    default:
      // pending, queued, in_progress, and anything GitHub adds.
      return 'pending';
  }
}

const toRepository = (repo: GitHubRepo): Repository => ({
  ref: { owner: repo.owner.login, name: repo.name },
  defaultBranch: repo.default_branch,
  private: repo.private,
  canPush: repo.permissions?.push,
});

/** A path as GitHub's `/git/refs/heads/<branch>` wants it: each segment encoded, the slashes kept. */
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

const repoPath = (ref: RepositoryRef) =>
  `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

function kindOf(entry: GitHubTreeEntry): EntryKind {
  if (entry.type === 'tree') return 'directory';
  if (entry.type === 'commit') return 'submodule';
  return entry.mode === '120000' ? 'symlink' : 'file';
}

function toEntry(entry: GitHubTreeEntry, prefix = ''): TreeEntry {
  return {
    path: prefix ? `${prefix}/${entry.path}` : entry.path,
    kind: kindOf(entry),
    id: entry.sha,
    size: entry.size,
    executable: entry.mode === '100755',
  };
}

export class GitHubProvider implements Provider {
  readonly name = 'github';
  readonly webhooks = true;
  private readonly client: GitHubClient;
  private readonly concurrency: number;

  constructor(private readonly options: GitHubProviderOptions) {
    this.client = new GitHubClient(options);
    this.concurrency = options.uploadConcurrency ?? 4;
  }

  async listRepositories(): Promise<Repository[]> {
    const repos =
      this.options.scope === 'installation'
        ? await this.client.paginate<GitHubRepo>(
            '/installation/repositories',
            (page) => (page as { repositories: GitHubRepo[] }).repositories,
          )
        : await this.client.paginate<GitHubRepo>('/user/repos', (page) => page as GitHubRepo[], {
            sort: 'full_name',
          });
    return repos.map(toRepository);
  }

  async getRepository(ref: RepositoryRef): Promise<Repository> {
    const { data } = await this.client.json<GitHubRepo>('GET', repoPath(ref));
    return toRepository(data!);
  }

  async getHead(
    ref: RepositoryRef,
    branch: string,
    options: { etag?: string | undefined } = {},
  ): Promise<HeadResult> {
    const { status, data, headers } = await this.client.json<{ object: { sha: string } }>(
      'GET',
      `${repoPath(ref)}/git/ref/heads/${encodePath(branch)}`,
      { etag: options.etag },
    );
    if (status === 304) return { changed: false };
    return {
      changed: true,
      head: { branch, commit: data!.object.sha, etag: headers.get('etag') ?? undefined },
    };
  }

  async createBranch(ref: RepositoryRef, branch: string, fromCommit: string): Promise<void> {
    try {
      await this.client.json('POST', `${repoPath(ref)}/git/refs`, {
        json: { ref: `refs/heads/${branch}`, sha: fromCommit },
      });
    } catch (error) {
      // GitHub answers a name that is taken, and a commit it does not have, with a 422 each, and tells them apart only by its words.
      if (error instanceof ProviderError && error.code === 'invalid_request') {
        if (/already exists/i.test(error.message))
          throw new ProviderError('branch_exists', `there is already a branch ${branch}`);
        if (/object does not exist|not a valid object|sha/i.test(error.message))
          throw new ProviderError('not_found', `there is no commit ${fromCommit}`);
      }
      throw error;
    }
  }

  async deleteBranch(ref: RepositoryRef, branch: string): Promise<void> {
    const repository = await this.getRepository(ref);
    // Checked here, and not left to the caller: the one branch that must never be deleted by a mistake.
    if (branch === repository.defaultBranch)
      throw new ProviderError('invalid_request', 'the default branch is not deleted from here');
    try {
      await this.client.empty('DELETE', `${repoPath(ref)}/git/refs/heads/${encodePath(branch)}`);
    } catch (error) {
      // GitHub answers a branch that is not there with a 422 ("Reference does not exist"), where the contract says not found.
      if (
        error instanceof ProviderError &&
        error.code === 'invalid_request' &&
        /does not exist/i.test(error.message)
      )
        throw new ProviderError('not_found', `there is no branch ${branch}`);
      throw error;
    }
  }

  async listBranches(ref: RepositoryRef, prefix: string): Promise<Branch[]> {
    try {
      const refs = await this.client.paginate<{ ref: string; object: { sha: string } }>(
        `${repoPath(ref)}/git/matching-refs/heads/${encodePath(prefix)}`,
        (page) => page as { ref: string; object: { sha: string } }[],
      );
      return refs
        .map((entry) => ({
          branch: entry.ref.replace(/^refs\/heads\//, ''),
          commit: entry.object.sha,
        }))
        .sort((a, b) => (a.branch < b.branch ? -1 : 1));
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'not_found') return [];
      throw error;
    }
  }

  async lastModified(
    ref: RepositoryRef,
    commit: string,
    path: string,
  ): Promise<string | undefined> {
    try {
      const answer = await this.client.json<
        { commit?: { committer?: { date?: string } | null; author?: { date?: string } | null } }[]
      >('GET', `${repoPath(ref)}/commits`, { query: { sha: commit, path, per_page: 1 } });
      const newest = answer.data?.[0]?.commit;
      return newest?.committer?.date ?? newest?.author?.date ?? undefined;
    } catch (error) {
      // What a page shows beside a file is not worth failing the page for: the host did not say.
      if (error instanceof ProviderError) return undefined;
      throw error;
    }
  }

  async fileHistory(
    ref: RepositoryRef,
    commit: string,
    path: string,
    limit: number,
  ): Promise<FileVersion[]> {
    const answer = await this.client.json<
      {
        sha: string;
        commit?: {
          message?: string;
          committer?: { date?: string } | null;
          author?: { name?: string; date?: string } | null;
        };
      }[]
    >('GET', `${repoPath(ref)}/commits`, {
      query: { sha: commit, path, per_page: Math.min(limit, 100) },
    });
    return (answer.data ?? []).map((entry) => ({
      commit: entry.sha,
      message: (entry.commit?.message ?? '').split('\n')[0] as string,
      author: entry.commit?.author?.name ?? null,
      date: entry.commit?.committer?.date ?? entry.commit?.author?.date ?? '',
    }));
  }

  async getBuildStatus(ref: RepositoryRef, commit: string): Promise<BuildStatus> {
    const repo = repoPath(ref);
    const [runs, combined, deployments] = await Promise.all([
      this.client.json<{
        check_runs?: {
          name: string;
          status?: string;
          conclusion?: string | null;
          html_url?: string | null;
          details_url?: string | null;
        }[];
      }>('GET', `${repo}/commits/${commit}/check-runs`, { query: { per_page: 100 } }),
      this.client.json<{
        statuses?: { context: string; state?: string; target_url?: string | null }[];
      }>('GET', `${repo}/commits/${commit}/status`, { query: { per_page: 100 } }),
      this.client.json<{ id: number; environment?: string }[]>('GET', `${repo}/deployments`, {
        query: { sha: commit, per_page: 10 },
      }),
    ]).catch((error: unknown) => {
      // GitHub answers a commit it does not have with a 422 ("No commit found for SHA"), where the rest of the contract says not found.
      if (error instanceof ProviderError && error.code === 'invalid_request')
        throw new ProviderError('not_found', `there is no commit ${commit}`);
      throw error;
    });
    const checks: BuildCheck[] = [];
    for (const run of runs.data?.check_runs ?? [])
      checks.push({
        name: run.name,
        state: checkRunState(run),
        url: safeUrl(run.html_url ?? run.details_url),
      });
    // GitHub's combined status says `pending` when nothing posted one, so it is read from the statuses and not its own state.
    for (const status of combined.data?.statuses ?? [])
      checks.push({
        name: status.context,
        state: statusState(status.state),
        url: safeUrl(status.target_url),
      });

    let siteUrl: string | undefined;
    for (const deployment of (deployments.data ?? []).slice(0, 5)) {
      // The newest status is first.
      const { data } = await this.client.json<
        { state?: string; environment_url?: string | null; target_url?: string | null }[]
      >('GET', `${repo}/deployments/${deployment.id}/statuses`, { query: { per_page: 1 } });
      const latest = data?.[0];
      if (!latest) continue;
      const state = statusState(latest.state);
      // An inactive deployment was replaced by a later one: it is no longer how the site is.
      if (latest.state === 'inactive') continue;
      checks.push({
        name: `deployment: ${deployment.environment ?? 'site'}`,
        state,
        url: safeUrl(latest.environment_url ?? latest.target_url),
      });
      if (state === 'success' && siteUrl === undefined) siteUrl = safeUrl(latest.environment_url);
    }
    return summarise(commit, checks, siteUrl);
  }

  async canWrite(ref: RepositoryRef, branch: string): Promise<boolean> {
    const current = await this.getHead(ref, branch);
    if (!current.changed)
      throw new ProviderError(
        'unavailable',
        'the host answered a head request that had no etag as unchanged',
      );
    try {
      // The branch is "moved" to where it already is: a fast-forward of nothing, never forced.
      // It needs the same permission as a real commit's last step, and changes nothing.
      await this.client.json('PATCH', `${repoPath(ref)}/git/refs/heads/${encodePath(branch)}`, {
        json: { sha: current.head.commit, force: false },
      });
      return true;
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'forbidden') return false;
      throw error;
    }
  }

  async getTree(ref: RepositoryRef, commit: string): Promise<Tree> {
    // A commit id is accepted where a tree id is expected: one request, not two.
    const { data } = await this.client.json<{ tree: GitHubTreeEntry[]; truncated: boolean }>(
      'GET',
      `${repoPath(ref)}/git/trees/${commit}`,
      { query: { recursive: 1 } },
    );
    return {
      commit,
      entries: data!.tree.map((entry) => toEntry(entry)),
      complete: !data!.truncated,
    };
  }

  async listDirectory(ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry[]> {
    const segments = path === '' ? [] : path.split('/');
    // Walk down from the commit, a request per level: the way to a directory is through its parents.
    let treeish = commit;
    for (const segment of segments) {
      const { data } = await this.client.json<{ tree: GitHubTreeEntry[] }>(
        'GET',
        `${repoPath(ref)}/git/trees/${treeish}`,
      );
      const found = data!.tree.find((entry) => entry.path === segment && entry.type === 'tree');
      if (!found)
        throw new ProviderError('not_found', `there is no directory "${path}" in that commit`);
      treeish = found.sha;
    }
    const { data } = await this.client.json<{ tree: GitHubTreeEntry[] }>(
      'GET',
      `${repoPath(ref)}/git/trees/${treeish}`,
    );
    return data!.tree.map((entry) => toEntry(entry, path));
  }

  async readBlob(
    ref: RepositoryRef,
    blob: string,
    options: { maxBytes?: number | undefined } = {},
  ): Promise<Uint8Array> {
    // The raw media type returns the file's bytes themselves, not base64 inside JSON.
    return this.client.bytes(`${repoPath(ref)}/git/blobs/${blob}`, {
      accept: 'application/vnd.github.raw+json',
      maxBytes: options.maxBytes,
    });
  }

  async commit(ref: RepositoryRef, request: CommitRequest): Promise<CommitResult> {
    validateCommitRequest(request);
    const repo = repoPath(ref);

    // Look before uploading anything: a head that has moved is the common failure, and it should cost
    // one request, not a commit's worth of blobs. The real guard is the fast-forward at the end.
    const current = await this.getHead(ref, request.branch);
    if (current.changed && current.head.commit !== request.expectedHead) {
      throw new ProviderError(
        'head_moved',
        `${request.branch} has moved on from ${request.expectedHead.slice(0, 7)}`,
      );
    }

    const base = await this.client.json<{ tree: { sha: string } }>(
      'GET',
      `${repo}/git/commits/${request.expectedHead}`,
    );
    const baseTree = base.data!.tree.sha;

    const entries = await mapLimit(request.changes, this.concurrency, async (change) =>
      this.treeEntry(repo, change),
    );
    const tree = await this.client.json<{ sha: string }>('POST', `${repo}/git/trees`, {
      json: { base_tree: baseTree, tree: entries },
    });
    if (tree.data!.sha === baseTree)
      throw new ProviderError('no_changes', 'the commit would not change anything');

    const created = await this.client.json<{ sha: string }>('POST', `${repo}/git/commits`, {
      json: {
        message: request.message,
        tree: tree.data!.sha,
        parents: [request.expectedHead],
        ...(request.author
          ? {
              author: {
                name: request.author.name,
                email: request.author.email,
                date: new Date().toISOString(),
              },
            }
          : {}),
      },
    });

    // Never by force: if the branch has moved since, this is refused and nothing of ours is on it.
    await this.client.json('PATCH', `${repo}/git/refs/heads/${encodePath(request.branch)}`, {
      json: { sha: created.data!.sha, force: false },
    });
    return { commit: created.data!.sha, parent: request.expectedHead, branch: request.branch };
  }

  verifyWebhook(request: WebhookRequest, secret: string): WebhookEvent {
    return verifyGitHubWebhook(request, secret);
  }

  private async treeEntry(
    repo: string,
    change: Change,
  ): Promise<{ path: string; mode: string; type: 'blob'; sha: string | null }> {
    if ('delete' in change) return { path: change.path, mode: '100644', type: 'blob', sha: null };
    const mode = change.executable ? '100755' : '100644';
    if ('blob' in change) return { path: change.path, mode, type: 'blob', sha: change.blob };
    const uploaded = await this.client.json<{ sha: string }>('POST', `${repo}/git/blobs`, {
      json: { content: Buffer.from(change.content).toString('base64'), encoding: 'base64' },
    });
    return { path: change.path, mode, type: 'blob', sha: uploaded.data!.sha };
  }
}
