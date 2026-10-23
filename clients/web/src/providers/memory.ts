import { ProviderError } from "./errors";
import { gitBlobId } from "./git-id";
import type { Change, CommitRequest, CommitResult, EntryKind, HeadResult, Provider, Repository, RepositoryRef, Tree, TreeEntry } from "./types";
import { repositoryKey } from "./types";
import { validateCommitRequest } from "./validate";
import { createHash } from "node:crypto";

/**
 * A git host in memory: the second implementation of `Provider`, which the rest of the app is
 * tested against, and which the contract tests hold to the same rules as GitHub's. Content is
 * addressed the way git does it (a blob's id is git's), so what a test reads can be checked.
 *
 * It does what the contract says and no more: no history, no webhooks.
 */
interface StoredFile {
  blob: string;
  executable: boolean;
}
interface StoredCommit {
  id: string;
  parent?: string;
  files: Map<string, StoredFile>;
}
interface StoredRepository {
  info: Repository;
  branches: Map<string, string>;
  commits: Map<string, StoredCommit>;
  blobs: Map<string, Uint8Array>;
}

export interface MemoryProviderOptions {
  /** Cut `getTree` short past this many entries, as a host does for a very large repository. */
  treeLimit?: number;
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const encoder = new TextEncoder();

export class MemoryProvider implements Provider {
  readonly name = "memory";
  readonly webhooks = false;
  private readonly repositories = new Map<string, StoredRepository>();
  private treeLimit: number | undefined;

  constructor(options: MemoryProviderOptions = {}) {
    this.treeLimit = options.treeLimit;
  }

  // --- Setting up (not part of Provider) ---------------------------------------------------

  createRepository(ref: RepositoryRef, options: { defaultBranch?: string; private?: boolean; canPush?: boolean } = {}): void {
    const defaultBranch = options.defaultBranch ?? "main";
    this.repositories.set(repositoryKey(ref), {
      info: { ref, defaultBranch, private: options.private ?? true, canPush: options.canPush ?? true },
      branches: new Map(),
      commits: new Map(),
      blobs: new Map(),
    });
  }

  setTreeLimit(limit: number | undefined): void {
    this.treeLimit = limit;
  }

  /** Make the branch contain exactly these files, as one commit on top of what is there. Returns the commit. */
  seed(ref: RepositoryRef, files: Record<string, string | Uint8Array | null>, options: { branch?: string; replace?: boolean } = {}): string {
    const repo = this.repo(ref);
    const branch = options.branch ?? repo.info.defaultBranch;
    const parent = repo.branches.get(branch);
    const next = options.replace || !parent ? new Map<string, StoredFile>() : new Map(repo.commits.get(parent)!.files);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) next.delete(path);
      else next.set(path, { blob: this.store(repo, typeof content === "string" ? encoder.encode(content) : content), executable: false });
    }
    return this.record(repo, branch, parent, next, `seed ${repo.commits.size + 1}`);
  }

  // --- Provider ----------------------------------------------------------------------------

  async listRepositories(): Promise<Repository[]> {
    return [...this.repositories.values()].map((repo) => repo.info);
  }

  async getRepository(ref: RepositoryRef): Promise<Repository> {
    return this.repo(ref).info;
  }

  async getHead(ref: RepositoryRef, branch: string, options: { etag?: string | undefined } = {}): Promise<HeadResult> {
    const commit = this.repo(ref).branches.get(branch);
    if (!commit) throw new ProviderError("not_found", `there is no branch "${branch}"`);
    const etag = `"${commit}"`;
    if (options.etag === etag) return { changed: false };
    return { changed: true, head: { branch, commit, etag } };
  }

  async canWrite(ref: RepositoryRef, branch: string): Promise<boolean> {
    // The branch has to be there, as it does for the real host; whether it may be written is the repository's setting.
    await this.getHead(ref, branch);
    return this.repo(ref).info.canPush !== false;
  }

  async getTree(ref: RepositoryRef, commit: string): Promise<Tree> {
    const stored = this.commitOf(this.repo(ref), commit);
    const entries = this.allEntries(this.repo(ref), stored);
    if (this.treeLimit !== undefined && entries.length > this.treeLimit) return { commit, entries: entries.slice(0, this.treeLimit), complete: false };
    return { commit, entries, complete: true };
  }

  async listDirectory(ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry[]> {
    const repo = this.repo(ref);
    const entries = this.allEntries(repo, this.commitOf(repo, commit));
    if (path !== "" && !entries.some((entry) => entry.path === path && entry.kind === "directory")) {
      throw new ProviderError("not_found", `there is no directory "${path}" in that commit`);
    }
    const prefix = path === "" ? "" : `${path}/`;
    return entries.filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/"));
  }

  async readBlob(ref: RepositoryRef, blob: string, options: { maxBytes?: number | undefined } = {}): Promise<Uint8Array> {
    const content = this.repo(ref).blobs.get(blob);
    if (!content) throw new ProviderError("not_found", "there is no such file");
    if (options.maxBytes !== undefined && content.byteLength > options.maxBytes) {
      throw new ProviderError("too_large", `the file is ${content.byteLength} bytes, over the limit of ${options.maxBytes}`);
    }
    return content;
  }

  async commit(ref: RepositoryRef, request: CommitRequest): Promise<CommitResult> {
    validateCommitRequest(request);
    const repo = this.repo(ref);
    const head = repo.branches.get(request.branch);
    if (!head) throw new ProviderError("not_found", `there is no branch "${request.branch}"`);
    // The same rule as a fast-forward: only if the branch is still where the caller read it.
    if (head !== request.expectedHead) throw new ProviderError("head_moved", `${request.branch} has moved on from ${request.expectedHead.slice(0, 7)}`);

    const next = new Map(repo.commits.get(head)!.files);
    for (const change of request.changes) this.apply(repo, next, change);
    if (sameFiles(next, repo.commits.get(head)!.files)) throw new ProviderError("no_changes", "the commit would not change anything");

    const commit = this.record(repo, request.branch, head, next, request.message);
    return { commit, parent: head, branch: request.branch };
  }

  // --- Internals ---------------------------------------------------------------------------

  private repo(ref: RepositoryRef): StoredRepository {
    const repo = this.repositories.get(repositoryKey(ref));
    if (!repo) throw new ProviderError("not_found", `there is no repository ${repositoryKey(ref)}`);
    return repo;
  }

  private commitOf(repo: StoredRepository, id: string): StoredCommit {
    const commit = repo.commits.get(id);
    if (!commit) throw new ProviderError("not_found", `there is no commit ${id.slice(0, 7)}`);
    return commit;
  }

  private store(repo: StoredRepository, content: Uint8Array): string {
    const id = gitBlobId(content);
    repo.blobs.set(id, content);
    return id;
  }

  private apply(repo: StoredRepository, files: Map<string, StoredFile>, change: Change): void {
    if ("delete" in change) {
      files.delete(change.path);
    } else if ("blob" in change) {
      if (!repo.blobs.has(change.blob)) throw new ProviderError("invalid_request", `there is no blob ${change.blob.slice(0, 7)} to put at "${change.path}"`);
      files.set(change.path, { blob: change.blob, executable: change.executable ?? false });
    } else {
      files.set(change.path, { blob: this.store(repo, change.content), executable: change.executable ?? false });
    }
  }

  private record(repo: StoredRepository, branch: string, parent: string | undefined, files: Map<string, StoredFile>, message: string): string {
    const listing = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, file]) => `${path}:${file.blob}:${file.executable}`).join("\n");
    const id = sha1(`${parent ?? ""}\n${message}\n${listing}\n${repo.commits.size}`);
    repo.commits.set(id, { id, ...(parent ? { parent } : {}), files });
    repo.branches.set(branch, id);
    return id;
  }

  /** Every file and every directory of a commit, in path order. */
  private allEntries(repo: StoredRepository, commit: StoredCommit): TreeEntry[] {
    const entries = new Map<string, TreeEntry>();
    for (const [path, file] of commit.files) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!entries.has(dir)) entries.set(dir, { path: dir, kind: "directory" as EntryKind, id: sha1(`tree:${dir}:${commit.id}`), executable: false });
      }
      entries.set(path, { path, kind: "file", id: file.blob, size: repo.blobs.get(file.blob)!.byteLength, executable: file.executable });
    }
    return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }
}

function sameFiles(a: Map<string, StoredFile>, b: Map<string, StoredFile>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, file] of a) {
    const other = b.get(path);
    if (!other || other.blob !== file.blob || other.executable !== file.executable) return false;
  }
  return true;
}
