import { ProviderError } from "../errors";
import type {
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
} from "../types";
import { mapLimit } from "../concurrency";
import { validateCommitRequest } from "../validate";
import { GitHubClient, type GitHubClientOptions } from "./http";
import { verifyGitHubWebhook } from "./webhook";

/**
 * GitHub, through its REST API and its Git Data endpoints (DESIGN.md §7). Reads go by git object
 * id; a commit is made the way git makes one (blobs, a tree on top of the head's, a commit, then a
 * fast-forward of the branch) so that it is atomic and never overwrites.
 *
 * `scope` says what `listRepositories` means: for a GitHub App's installation token, the
 * repositories the App was installed on; for a personal access token, the ones the user can reach.
 */
export interface GitHubProviderOptions extends GitHubClientOptions {
  scope: "installation" | "user";
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
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

const toRepository = (repo: GitHubRepo): Repository => ({
  ref: { owner: repo.owner.login, name: repo.name },
  defaultBranch: repo.default_branch,
  private: repo.private,
  canPush: repo.permissions?.push,
});

/** A path as GitHub's `/git/refs/heads/<branch>` wants it: each segment encoded, the slashes kept. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const repoPath = (ref: RepositoryRef) => `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

function kindOf(entry: GitHubTreeEntry): EntryKind {
  if (entry.type === "tree") return "directory";
  if (entry.type === "commit") return "submodule";
  return entry.mode === "120000" ? "symlink" : "file";
}

function toEntry(entry: GitHubTreeEntry, prefix = ""): TreeEntry {
  return {
    path: prefix ? `${prefix}/${entry.path}` : entry.path,
    kind: kindOf(entry),
    id: entry.sha,
    size: entry.size,
    executable: entry.mode === "100755",
  };
}

export class GitHubProvider implements Provider {
  readonly name = "github";
  readonly webhooks = true;
  private readonly client: GitHubClient;
  private readonly concurrency: number;

  constructor(private readonly options: GitHubProviderOptions) {
    this.client = new GitHubClient(options);
    this.concurrency = options.uploadConcurrency ?? 4;
  }

  async listRepositories(): Promise<Repository[]> {
    const repos =
      this.options.scope === "installation"
        ? await this.client.paginate<GitHubRepo>("/installation/repositories", (page) => (page as { repositories: GitHubRepo[] }).repositories)
        : await this.client.paginate<GitHubRepo>("/user/repos", (page) => page as GitHubRepo[], { sort: "full_name" });
    return repos.map(toRepository);
  }

  async getRepository(ref: RepositoryRef): Promise<Repository> {
    const { data } = await this.client.json<GitHubRepo>("GET", repoPath(ref));
    return toRepository(data!);
  }

  async getHead(ref: RepositoryRef, branch: string, options: { etag?: string | undefined } = {}): Promise<HeadResult> {
    const { status, data, headers } = await this.client.json<{ object: { sha: string } }>("GET", `${repoPath(ref)}/git/ref/heads/${encodePath(branch)}`, { etag: options.etag });
    if (status === 304) return { changed: false };
    return { changed: true, head: { branch, commit: data!.object.sha, etag: headers.get("etag") ?? undefined } };
  }

  async getTree(ref: RepositoryRef, commit: string): Promise<Tree> {
    // A commit id is accepted where a tree id is expected: one request, not two.
    const { data } = await this.client.json<{ tree: GitHubTreeEntry[]; truncated: boolean }>("GET", `${repoPath(ref)}/git/trees/${commit}`, { query: { recursive: 1 } });
    return { commit, entries: data!.tree.map((entry) => toEntry(entry)), complete: !data!.truncated };
  }

  async listDirectory(ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry[]> {
    const segments = path === "" ? [] : path.split("/");
    // Walk down from the commit, a request per level: the way to a directory is through its parents.
    let treeish = commit;
    for (const segment of segments) {
      const { data } = await this.client.json<{ tree: GitHubTreeEntry[] }>("GET", `${repoPath(ref)}/git/trees/${treeish}`);
      const found = data!.tree.find((entry) => entry.path === segment && entry.type === "tree");
      if (!found) throw new ProviderError("not_found", `there is no directory "${path}" in that commit`);
      treeish = found.sha;
    }
    const { data } = await this.client.json<{ tree: GitHubTreeEntry[] }>("GET", `${repoPath(ref)}/git/trees/${treeish}`);
    return data!.tree.map((entry) => toEntry(entry, path));
  }

  async readBlob(ref: RepositoryRef, blob: string, options: { maxBytes?: number | undefined } = {}): Promise<Uint8Array> {
    // The raw media type returns the file's bytes themselves, not base64 inside JSON.
    return this.client.bytes(`${repoPath(ref)}/git/blobs/${blob}`, { accept: "application/vnd.github.raw+json", maxBytes: options.maxBytes });
  }

  async commit(ref: RepositoryRef, request: CommitRequest): Promise<CommitResult> {
    validateCommitRequest(request);
    const repo = repoPath(ref);

    // Look before uploading anything: a head that has moved is the common failure, and it should cost
    // one request, not a commit's worth of blobs. The real guard is the fast-forward at the end.
    const current = await this.getHead(ref, request.branch);
    if (current.changed && current.head.commit !== request.expectedHead) {
      throw new ProviderError("head_moved", `${request.branch} has moved on from ${request.expectedHead.slice(0, 7)}`);
    }

    const base = await this.client.json<{ tree: { sha: string } }>("GET", `${repo}/git/commits/${request.expectedHead}`);
    const baseTree = base.data!.tree.sha;

    const entries = await mapLimit(request.changes, this.concurrency, async (change) => this.treeEntry(repo, change));
    const tree = await this.client.json<{ sha: string }>("POST", `${repo}/git/trees`, { json: { base_tree: baseTree, tree: entries } });
    if (tree.data!.sha === baseTree) throw new ProviderError("no_changes", "the commit would not change anything");

    const created = await this.client.json<{ sha: string }>("POST", `${repo}/git/commits`, {
      json: {
        message: request.message,
        tree: tree.data!.sha,
        parents: [request.expectedHead],
        ...(request.author ? { author: { name: request.author.name, email: request.author.email, date: new Date().toISOString() } } : {}),
      },
    });

    // Never by force: if the branch has moved since, this is refused and nothing of ours is on it.
    await this.client.json("PATCH", `${repo}/git/refs/heads/${encodePath(request.branch)}`, { json: { sha: created.data!.sha, force: false } });
    return { commit: created.data!.sha, parent: request.expectedHead, branch: request.branch };
  }

  verifyWebhook(request: WebhookRequest, secret: string): WebhookEvent {
    return verifyGitHubWebhook(request, secret);
  }

  private async treeEntry(repo: string, change: Change): Promise<{ path: string; mode: string; type: "blob"; sha: string | null }> {
    if ("delete" in change) return { path: change.path, mode: "100644", type: "blob", sha: null };
    const mode = change.executable ? "100755" : "100644";
    if ("blob" in change) return { path: change.path, mode, type: "blob", sha: change.blob };
    const uploaded = await this.client.json<{ sha: string }>("POST", `${repo}/git/blobs`, {
      json: { content: Buffer.from(change.content).toString("base64"), encoding: "base64" },
    });
    return { path: change.path, mode, type: "blob", sha: uploaded.data!.sha };
  }
}
