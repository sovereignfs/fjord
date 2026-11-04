/**
 * What Fjord Web needs from a git host (DESIGN.md §7). GitHub is the first implementation and
 * not an assumption: the rest of the app speaks this interface, so another host is one more
 * implementation, and a test can use an in-memory one.
 *
 * Everything is by git object id, so a result never changes underneath its reader: a tree
 * read for a commit is that commit's tree for ever, and is what the app caches (DESIGN.md §8).
 */

export interface RepositoryRef {
  owner: string;
  name: string;
}

export const repositoryKey = (ref: RepositoryRef): string => `${ref.owner}/${ref.name}`;

export interface Repository {
  ref: RepositoryRef;
  defaultBranch: string;
  private: boolean;
  /**
   * Whether the credential can write to it, when the host says. Some hosts do not say for
   * every kind of credential, so `undefined` means "not known", not "no".
   */
  canPush?: boolean | undefined;
}

export interface Head {
  branch: string;
  /** The commit the branch points at. */
  commit: string;
  /** What to send back to ask "has it changed?" without spending a rate limit, where the host has one. */
  etag?: string | undefined;
}

export type HeadResult = { changed: false } | { changed: true; head: Head };

export type EntryKind = "file" | "directory" | "symlink" | "submodule";

export interface TreeEntry {
  /** From the repository root, with `/` separators. */
  path: string;
  kind: EntryKind;
  /** The object id: a file's blob, a directory's tree, a submodule's commit. */
  id: string;
  /** Bytes, for a file; the host does not say for the others. */
  size?: number | undefined;
  /** For a file. */
  executable: boolean;
}

export interface Tree {
  commit: string;
  entries: TreeEntry[];
  /**
   * False when the host cut the listing short, which it does for very large repositories. What
   * is missing is read with `listDirectory`, one directory at a time (DESIGN.md §8).
   */
  complete: boolean;
}

export interface Identity {
  name: string;
  email: string;
}

/** One file's fate in a commit. A folder is changed by changing each of its files. */
export type Change =
  /** Create the file, or replace it. */
  | { path: string; content: Uint8Array; executable?: boolean | undefined }
  /** Put an existing blob at this path: a move or a copy, which re-uploads nothing. */
  | { path: string; blob: string; executable?: boolean | undefined }
  | { path: string; delete: true };

export interface CommitRequest {
  branch: string;
  /**
   * The commit the caller read, and built the changes on. The branch is moved only if it is
   * still there, and never by force: if anything has landed since, the answer is `head_moved`
   * and nothing is written to the branch.
   */
  expectedHead: string;
  message: string;
  /** Who made the change; the host's own identity commits it. */
  author?: Identity | undefined;
  changes: Change[];
}

/** A branch and the commit it is at. */
export interface Branch {
  branch: string;
  commit: string;
}

export interface CommitResult {
  commit: string;
  parent: string;
  branch: string;
}

/** How a build, a check or a deployment of a commit stands. */
export type BuildState = "pending" | "success" | "failure";

/** One thing the host reports of a commit: a check run, a status, or a deployment. */
export interface BuildCheck {
  name: string;
  state: BuildState;
  /** Where the host shows it (its log, or the deployment), when it says. */
  url?: string | undefined;
}

/**
 * What a git host reports of a commit's build (ROADMAP 3c.3, Research 0001): the checks, statuses and deployments the host's own
 * integrations posted. Fjord configures none of them and builds nothing; a host that reports nothing has `state: "none"`.
 */
export interface BuildStatus {
  commit: string;
  /** `none` when nothing is reported; else `failure` if any failed, `pending` if any is not done, `success` when all are. */
  state: "none" | BuildState;
  checks: BuildCheck[];
  /** Where the commit's site is, when a successful deployment of it says (`environment_url` on GitHub). */
  siteUrl?: string | undefined;
}

/** What a `push` webhook says: a branch moved. */
export type WebhookEvent =
  | { kind: "push"; repository: RepositoryRef; branch: string; before: string; after: string; deleted: boolean }
  | { kind: "ping" }
  /**
   * Repositories the credential can no longer reach: some were taken off an installation of the GitHub App
   * (`installation_repositories`, action `removed`), or the installation was deleted (`installation`, action
   * `deleted`), which lists them all when GitHub says so.
   */
  | { kind: "access_removed"; repositories: RepositoryRef[] }
  /** An event this app does not act on. */
  | { kind: "ignored"; event: string };

export interface WebhookRequest {
  headers: Headers | Record<string, string | undefined>;
  /** The body exactly as received: the signature is over its bytes. */
  body: Uint8Array | string;
}

export interface Provider {
  readonly name: string;

  /** The repositories this credential can reach. */
  listRepositories(): Promise<Repository[]>;
  getRepository(ref: RepositoryRef): Promise<Repository>;

  /** A branch's head. With an `etag` from an earlier head, says whether it has moved. */
  getHead(ref: RepositoryRef, branch: string, options?: { etag?: string | undefined }): Promise<HeadResult>;

  /** Every path in the commit, with sizes and ids. See `Tree.complete`. */
  getTree(ref: RepositoryRef, commit: string): Promise<Tree>;
  /** The direct children of one directory (`""` is the root), for a tree that was cut short. */
  listDirectory(ref: RepositoryRef, commit: string, path: string): Promise<TreeEntry[]>;

  /** A file's bytes by blob id. `too_large` if it is past `maxBytes`. */
  readBlob(ref: RepositoryRef, blob: string, options?: { maxBytes?: number | undefined }): Promise<Uint8Array>;

  /** Several file changes as one commit, on top of the head the caller read. See `CommitRequest`. */
  commit(ref: RepositoryRef, request: CommitRequest): Promise<CommitResult>;

  /**
   * Whether this credential can write to a branch, found out by trying something that changes
   * nothing: pointing the branch at the commit it is already on. Asking the host what it
   * permits is not enough (a fine-grained token's grants are not what a repository reports),
   * and the only trustworthy answer is the host's own refusal. `false` is a credential that can
   * read and not write; a credential that is rejected outright, or a branch that is not there,
   * throws as it does anywhere else.
   */
  canWrite(ref: RepositoryRef, branch: string): Promise<boolean>;

  /**
   * Make a branch at a commit (ROADMAP 3d.1): for a preview, which is a commit on a branch of its own and never on the one the person works
   * on. `branch_exists` if there is one of that name, and `not_found` for a commit the host does not have. Nothing is moved: a branch that is
   * there is never reset (no force, anywhere).
   */
  createBranch(ref: RepositoryRef, branch: string, fromCommit: string): Promise<void>;

  /**
   * Delete a branch. Never the repository's default branch, which is refused as `invalid_request`: a caller that can name a branch can name that
   * one by mistake. `not_found` for a branch that is not there.
   */
  deleteBranch(ref: RepositoryRef, branch: string): Promise<void>;

  /**
   * When a file last changed as of a commit: the date, as the host writes it (ISO 8601), of the newest commit up to it that touched `path`; undefined when the host cannot say or the
   * path has no history. **Optional** and one file at a time: it is a request to the host's history, which a listing of many files must not make, so it is asked for the one file a page
   * opens. A host that does not keep it, or a provider made for tests, leaves it out.
   */
  lastModified?(ref: RepositoryRef, commit: string, path: string): Promise<string | undefined>;

  /** The branches whose names begin with `prefix`, with their heads. */
  listBranches(ref: RepositoryRef, prefix: string): Promise<Branch[]>;

  /**
   * What the host reports of a commit's build: its checks, statuses and deployments (ROADMAP 3c.3). Nothing reported is `state: "none"`,
   * not an error. `not_found` for a commit the host does not have; `forbidden` for a credential that may not read them (a fine-grained
   * token needs "Checks", "Commit statuses" and "Deployments", read).
   */
  getBuildStatus(ref: RepositoryRef, commit: string): Promise<BuildStatus>;

  /**
   * Whether this host sends change notifications. Where it does not, the app asks `getHead`
   * again now and then; where it does, `verifyWebhook` is how one is trusted.
   */
  readonly webhooks: boolean;
  /** Check a notification's signature against the shared secret and say what it reports. Throws `invalid_webhook`. */
  verifyWebhook?(request: WebhookRequest, secret: string): WebhookEvent;
}
