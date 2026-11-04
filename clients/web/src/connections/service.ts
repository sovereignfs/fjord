import { sql } from "drizzle-orm";
import type { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { isProviderError } from "../providers/errors";
import { type LocalLimits, type LocalUsage, localLimits } from "../local/limits";
import { LOCAL_BRANCH, LOCAL_OWNER, LocalProvider, validRepositoryName } from "../local/provider";
import { restoreWindowMs } from "../files/config";
import { type Provider, type RepositoryRef, repositoryKey } from "../providers/types";
import { ConnectionError } from "./errors";
import { newPublicId } from "./public-id";
import { parseRepository } from "./repository-url";

/**
 * The repositories an account has connected (DESIGN.md §7). Adding one by a personal access token
 * is where a token is checked before anything is kept: that GitHub accepts it, that it can see the
 * repository, that there is something in it, and that it can write (by trying, since a repository's
 * reported permissions are not what a fine-grained token was granted). Only a token that passes is
 * stored, encrypted (`src/crypto/`); the connection holds its id. Every call is for one account
 * and only ever sees that account's connections: one that is someone else's is "not found".
 *
 * Nothing here returns, logs or puts in an error a token, and the messages a person reads are
 * ours, not GitHub's.
 */
export interface ConnectionInfo {
  id: number;
  /** What it is called in an address (`src/connections/public-id.ts`); `id` is the database's and is never shown in one. */
  publicId: string;
  /** Where its addresses begin, without the slash: `<kind>/<publicId>` (`drive/k3x9m2qa`), by the kind it was last read as (a drive until it has been). `/repo/<publicId>` is sent to it. */
  address: string;
  /** `local`: a repository that lives on this server until it is connected to git (ROADMAP 3i). */
  provider: "github" | "local";
  /** `pat`: a personal access token the person gave. `app`: an installation of the instance's GitHub App (ROADMAP 1a.6). `local`: kept on this server, so it has no credential. */
  kind: "pat" | "app" | "local";
  owner: string;
  name: string;
  branch: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Where `/` lands for this account. Exactly one of an account's connections is. */
  isDefault: boolean;
  /**
   * The vault (its directory) the account chose to open first, or null until it does. What opens when it is null, or
   * when the vault has since gone, is decided from the repository (`src/browse/default-vault.ts`), not stored.
   */
  defaultVault: string | null;
  /** The kind the repository was when it was last read, for its icon in the rail and its tile; null until it has been. A hint: the manifest decides. */
  repoKind: "drive" | "journal" | "ssg" | null;
}

export interface Added {
  connection: ConnectionInfo;
  /** Things worth telling the person that did not stop it, e.g. a token that reaches more than it needs to. */
  warnings: string[];
}

/** What came of connecting the repositories an installation reaches. */
export interface InstallationResult {
  added: ConnectionInfo[];
  /** Connected before by this account. */
  already: RepositoryRef[];
  /** Left out, and why: `empty` (nothing in it yet), `read_only` (the App was not given Contents: write), `unavailable`. */
  skipped: { ref: RepositoryRef; reason: "empty" | "read_only" | "unavailable" }[];
}

export interface ConnectionServiceOptions {
  database: Database;
  credentials: CredentialStore;
  /** A provider for GitHub with this personal access token. */
  github: (token: string) => Provider;
  /** A provider for one installation of the instance's GitHub App, which renews its own short-lived tokens. Absent when there is no App. */
  githubApp?: (installationId: number) => Provider;
  /** What an account may keep on this server before it connects a repository to git; read from the environment when not given (`src/local/limits.ts`). */
  localLimits?: LocalLimits;
  /** For tests. */
  now?: () => number;
}

const PURPOSE = "github-pat";
/** What the credential store holds for an App connection: not a secret, but the installation to ask GitHub for tokens for, kept apart from the repository and with the same lifetime. */
const INSTALLATION_PURPOSE = "github-app-installation";
const MAX_TOKEN_LENGTH = 1000;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.connection : sqliteSchema.connection);
const trees = (database: Database) => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);
const drafts = (database: Database) => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);
const docIndex = (database: Database) => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const fileHandles = (database: Database) => (database.dialect === "postgres" ? postgresSchema.fileHandle : sqliteSchema.fileHandle);
const publications = (database: Database) => (database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication);
const journalEntries = (database: Database) => (database.dialect === "postgres" ? postgresSchema.journalEntry : sqliteSchema.journalEntry);
const userShares = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);
const sealedShares = (database: Database) => (database.dialect === "postgres" ? postgresSchema.sealedShare : sqliteSchema.sealedShare);
const linkShares = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);
const commentTables = (database: Database) => (database.dialect === "postgres" ? [postgresSchema.commentReply, postgresSchema.commentThread, postgresSchema.commentActivity, postgresSchema.commentClosed] : [sqliteSchema.commentReply, sqliteSchema.commentThread, sqliteSchema.commentActivity, sqliteSchema.commentClosed]);
const deletions = (database: Database) => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);
const defaults = (database: Database) => (database.dialect === "postgres" ? postgresSchema.accountDefault : sqliteSchema.accountDefault);
const COLUMNS = sql.raw('id, kind, owner, name, branch, created_at AS "createdAt", credential_id AS "credentialId", provider, account_id AS "accountId", default_vault AS "defaultVault", repo_kind AS "repoKind", public_id AS "publicId"');

interface Row {
  id: number;
  provider: string;
  accountId: string;
  kind: string;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
  credentialId: string;
  defaultVault: string | null;
  repoKind: string | null;
  publicId: string | null;
}

const toInfo = (row: Row, isDefault: boolean): ConnectionInfo => ({
  id: Number(row.id),
  publicId: row.publicId ?? "",
  address: `${row.repoKind === "journal" || row.repoKind === "ssg" ? row.repoKind : "drive"}/${row.publicId ?? ""}`,
  provider: row.provider === "local" ? "local" : "github",
  kind: row.provider === "local" ? "local" : row.kind === "app" ? "app" : "pat",
  owner: row.owner,
  name: row.name,
  branch: row.branch,
  createdAt: Number(row.createdAt),
  isDefault,
  defaultVault: row.defaultVault ?? null,
  repoKind: row.repoKind === "drive" || row.repoKind === "journal" || row.repoKind === "ssg" ? row.repoKind : null,
});

export class ConnectionService {
  private readonly database: Database;
  private readonly credentials: CredentialStore;
  private readonly github: (token: string) => Provider;
  private readonly githubApp: ((installationId: number) => Provider) | undefined;
  private readonly now: () => number;
  private readonly limits: LocalLimits;

  constructor(options: ConnectionServiceOptions) {
    this.database = options.database;
    this.credentials = options.credentials;
    this.github = options.github;
    this.githubApp = options.githubApp;
    this.now = options.now ?? Date.now;
    this.limits = options.localLimits ?? localLimits();
  }

  /**
   * Check a token against a repository, as connecting it does, and give back what was found: the provider that holds the token, the
   * repository as the host names it, its branch and that branch's head. Throws a `ConnectionError` in our words for whatever is
   * wrong (a token GitHub does not accept, a repository it cannot see, an empty one, one that is already connected, one the token
   * cannot write to). Nothing is kept. Connecting a repository and syncing a server-side one to it both begin here.
   */
  async checkTarget(accountId: string, input: { repository: string; token: string }): Promise<{ provider: Provider; token: string; ref: RepositoryRef; branch: string; head: string }> {
    const wanted = parseRepository(input.repository);
    const token = cleanToken(input.token);
    const provider = this.github(token);

    // Each step is the first thing that would go wrong for a person, in the order they would fix it.
    const repository = await this.asked(() => provider.getRepository(wanted), wanted);
    const ref = repository.ref;
    const branch = repository.defaultBranch;
    const head = await this.headOf(provider, ref, branch);

    if (await this.find(accountId, ref)) {
      throw new ConnectionError("already_connected", `${repositoryKey(ref)} is already connected.`);
    }
    if (!(await this.asked(() => provider.canWrite(ref, branch), ref))) {
      throw new ConnectionError(
        "read_only",
        "That token can read this repository but not write to it. Create the token with the repository permission “Contents: Read and write”, and try again.",
      );
    }
    return { provider, token, ref, branch, head };
  }

  /** Check a token against a repository and, if it is good for Fjord, keep both. */
  async addWithToken(accountId: string, input: { repository: string; token: string }): Promise<Added> {
    const { provider, token, ref, branch } = await this.checkTarget(accountId, input);

    const warnings = await this.warnings(provider, ref);

    const credentialId = await this.credentials.put(PURPOSE, token, this.now());
    try {
      const rows = await dbAll<Row>(
        this.database,
        sql`INSERT INTO ${table(this.database)} (account_id, provider, kind, owner, name, branch, credential_id, created_at, public_id)
            VALUES (${accountId}, 'github', 'pat', ${ref.owner}, ${ref.name}, ${branch}, ${credentialId}, ${this.now()}, ${await this.freshPublicId()})
            RETURNING ${COLUMNS}`,
      );
      const row = rows[0] as Row;
      // The first repository an account connects is its default; one that is not the first is not.
      const isDefault = await this.defaultIfNone(accountId, Number(row.id));
      return { connection: toInfo(row, isDefault), warnings };
    } catch (error) {
      // Nothing may be left holding a token that no connection points to.
      await this.credentials.remove(credentialId);
      throw error;
    }
  }

  async list(accountId: string): Promise<ConnectionInfo[]> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE account_id = ${accountId} ORDER BY id ASC`);
    // A connection made before addresses had names gets its own now, once.
    for (const row of rows) if (!row.publicId) row.publicId = await this.nameIt(Number(row.id));
    const chosen = this.effectiveDefault(rows, await this.storedDefault(accountId));
    return rows.map((row) => toInfo(row, Number(row.id) === chosen));
  }

  /** One of this account's connections by what it is called in an address (`/repo/<publicId>`), or by the number it was called before those (`/repo/3`). */
  async getByPublicId(accountId: string, publicId: string): Promise<ConnectionInfo | undefined> {
    return (await this.list(accountId)).find((connection) => connection.publicId === publicId);
  }

  /** A public id that no connection has. The unique index is what makes it certain; this only keeps a collision from being a failure. */
  private async freshPublicId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = newPublicId();
      const taken = await dbGet<{ id: number }>(this.database, sql`SELECT id FROM ${table(this.database)} WHERE public_id = ${candidate}`);
      if (!taken) return candidate;
    }
    throw new Error("a public id could not be made");
  }

  private async nameIt(id: number): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = await this.freshPublicId();
      // Only a row that has none is given one, so two requests listing at once agree on the first.
      await dbRun(this.database, sql`UPDATE ${table(this.database)} SET public_id = ${candidate} WHERE id = ${id} AND public_id IS NULL`);
      const row = await dbGet<{ publicId: string | null }>(this.database, sql`SELECT public_id AS "publicId" FROM ${table(this.database)} WHERE id = ${id}`);
      if (row?.publicId) return row.publicId;
    }
    throw new Error("a public id could not be kept");
  }

  async get(accountId: string, id: number): Promise<ConnectionInfo | undefined> {
    return (await this.list(accountId)).find((connection) => connection.id === id);
  }

  /** Where `/` lands: the connection chosen as the default, or the account's first if none is (or it is gone). */
  async defaultFor(accountId: string): Promise<ConnectionInfo | undefined> {
    const all = await this.list(accountId);
    return all.find((connection) => connection.isDefault);
  }

  /** Make one of this account's connections its default. False if it is not theirs (or not there). */
  async setDefault(accountId: string, id: number): Promise<boolean> {
    if (!(await this.get(accountId, id))) return false;
    await this.writeDefault(accountId, id);
    return true;
  }

  /**
   * Choose which vault of one of this account's repositories opens first, or forget the choice (null). False if the
   * connection is not this account's (or not there). Whether the vault exists is the caller's to have checked against
   * the repository: the service has no view of it, and a choice that has gone is ignored on reading.
   */
  /** Remembers the kind a repository was read as, for the icon of one that is not open (a hint: the manifest decides, and is read again). */
  async setRepoKind(accountId: string, id: number, kind: "drive" | "journal" | "ssg"): Promise<void> {
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET repo_kind = ${kind} WHERE id = ${id} AND account_id = ${accountId}`);
  }

  async setDefaultVault(accountId: string, id: number, vault: string | null): Promise<boolean> {
    if (!(await this.get(accountId, id))) return false;
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET default_vault = ${vault} WHERE id = ${id} AND account_id = ${accountId}`);
    return true;
  }

  /** Disconnect: the connection and its token are deleted. False if it is not this account's (or not there). */
  /**
   * Every connection an account has, removed as `remove` does one (what hangs on each goes with it, its credential too), and the
   * account's default. For an account that is being deleted (`src/sovereign/people.ts`). It can be run again: what is not there is skipped.
   */
  async removeAll(accountId: string): Promise<number> {
    const rows = await dbAll<{ id: number }>(this.database, sql`SELECT id FROM ${table(this.database)} WHERE account_id = ${accountId}`);
    for (const { id } of rows) await this.remove(accountId, Number(id));
    await dbRun(this.database, sql`DELETE FROM ${defaults(this.database)} WHERE account_id = ${accountId}`);
    // A server-side repository whose connection was never made (a request that stopped between the two) is the account's too.
    await this.localProvider(accountId).destroyAll();
    return rows.length;
  }

  async remove(accountId: string, id: number): Promise<boolean> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    if (!row) return false;
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    await dbRun(this.database, sql`DELETE FROM ${defaults(this.database)} WHERE account_id = ${accountId} AND connection_id = ${id}`);
    // Its trees are of nothing now.
    await dbRun(this.database, sql`DELETE FROM ${trees(this.database)} WHERE connection_id = ${id}`);
    // So are the drafts: they are of files of a repository this account no longer has a way into.
    await dbRun(this.database, sql`DELETE FROM ${drafts(this.database)} WHERE connection_id = ${id}`);
    // And the record of what was deleted: it is of files of a repository that is no longer connected.
    await dbRun(this.database, sql`DELETE FROM ${deletions(this.database)} WHERE connection_id = ${id}`);
    // And what was learnt of which Doc is where.
    await dbRun(this.database, sql`DELETE FROM ${docIndex(this.database)} WHERE connection_id = ${id}`);
    // And the handles that were made for its paths (ROADMAP 3e.2): a handle of a repository that is gone leads nowhere.
    await dbRun(this.database, sql`DELETE FROM ${fileHandles(this.database)} WHERE connection_id = ${id}`);
    // And the pages published from it (ROADMAP 3h.1): their addresses end with the repository.
    // Their sealed addresses go with them.
    for (const page of await dbAll<{ credential: string | null }>(this.database, sql`SELECT token_credential AS credential FROM ${publications(this.database)} WHERE connection_id = ${id}`)) {
      if (page.credential) await this.credentials.remove(page.credential);
    }
    await dbRun(this.database, sql`DELETE FROM ${publications(this.database)} WHERE connection_id = ${id}`);
    // And what a journal's timeline knew of its entries.
    await dbRun(this.database, sql`DELETE FROM ${journalEntries(this.database)} WHERE connection_id = ${id}`);
    // And what was shared from it: the documents are not reachable any more.
    await dbRun(this.database, sql`DELETE FROM ${userShares(this.database)} WHERE connection_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${linkShares(this.database)} WHERE connection_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${sealedShares(this.database)} WHERE connection_id = ${id}`);
    // And what was said about its documents.
    for (const comments of commentTables(this.database)) await dbRun(this.database, sql`DELETE FROM ${comments} WHERE connection_id = ${id}`);
    if (row.provider === "local") await this.localProvider(accountId).destroy({ owner: row.owner, name: row.name });
    else await this.credentials.remove(row.credentialId);
    return true;
  }

  /**
   * A provider for one of this account's connections, with its token decrypted, for the server to use
   * and for nothing else: the token goes into the provider and is not returned.
   */
  async provider(accountId: string, id: number): Promise<{ provider: Provider; connection: ConnectionInfo } | undefined> {
    const connection = await this.get(accountId, id);
    if (!connection) return undefined;
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    return { provider: await this.providerOf(row as Row), connection };
  }

  /**
   * A provider for a connection **on behalf of a share** (ROADMAP 1c.2): the owner's token, to read the one document that was
   * shared, for a person who has no connection of their own. It does not check who is asking, so it is only called after a
   * share was found for them, and what it reads is that document and nothing the share does not name.
   */
  async providerForShare(id: number): Promise<{ provider: Provider; id: number; ref: { owner: string; name: string }; branch: string; ownerId: string } | undefined> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id}`);
    if (!row) return undefined;
    return { provider: await this.providerOf(row), id, ref: { owner: row.owner, name: row.name }, branch: row.branch, ownerId: row.accountId };
  }

  /** The provider a connection is used through: its token, or its installation's tokens. */
  private async providerOf(row: Row): Promise<Provider> {
    // A repository on this server has no credential: it is the database, for the account that owns it.
    if (row.provider === "local") return this.localProvider(row.accountId);
    const { secret } = await this.credentials.get(row.credentialId);
    if (row.kind !== "app") return this.github(secret);
    if (!this.githubApp) throw new ConnectionError("not_configured", "This repository is connected through a GitHub App, which this instance is no longer set up with.");
    return this.githubApp(Number(secret));
  }

  /**
   * Connect repositories that an installation of the GitHub App reaches (ROADMAP 1a.6), for an account that has been shown to be
   * able to reach them (`src/github-app/install.ts` does that before this is called). Each one is checked as a token's repository is:
   * it must have something in it and the App must be able to write to it. One that fails is left out and said so; the rest go on.
   * No token is kept, only which installation: tokens are asked for when they are needed.
   */
  async addFromInstallation(accountId: string, installationId: number, provider: Provider, repositories: RepositoryRef[]): Promise<InstallationResult> {
    const result: InstallationResult = { added: [], already: [], skipped: [] };
    for (const wanted of repositories) {
      if (await this.find(accountId, wanted)) {
        result.already.push(wanted);
        continue;
      }
      let ref = wanted;
      let branch: string;
      try {
        const repository = await provider.getRepository(wanted);
        ref = repository.ref;
        branch = repository.defaultBranch;
        try {
          await provider.getHead(ref, branch);
        } catch (error) {
          if (isProviderError(error, "not_found")) {
            result.skipped.push({ ref, reason: "empty" });
            continue;
          }
          throw error;
        }
        if (!(await provider.canWrite(ref, branch))) {
          result.skipped.push({ ref, reason: "read_only" });
          continue;
        }
      } catch (error) {
        // The whole installation is refused, or limited: that is not one repository's trouble.
        if (isProviderError(error, "unauthorized") || isProviderError(error, "rate_limited")) throw explainProviderError(error, wanted);
        result.skipped.push({ ref, reason: "unavailable" });
        continue;
      }

      const credentialId = await this.credentials.put(INSTALLATION_PURPOSE, String(installationId), this.now());
      try {
        const rows = await dbAll<Row>(
          this.database,
          sql`INSERT INTO ${table(this.database)} (account_id, provider, kind, owner, name, branch, credential_id, created_at, public_id)
              VALUES (${accountId}, 'github', 'app', ${ref.owner}, ${ref.name}, ${branch}, ${credentialId}, ${this.now()}, ${await this.freshPublicId()})
              RETURNING ${COLUMNS}`,
        );
        const row = rows[0] as Row;
        result.added.push(toInfo(row, await this.defaultIfNone(accountId, Number(row.id))));
      } catch (error) {
        await this.credentials.remove(credentialId);
        // Connected a moment ago by another request of this account: the same as before.
        if (await this.find(accountId, ref)) result.already.push(ref);
        else throw error;
      }
    }
    return result;
  }

  /**
   * The GitHub App can no longer reach these repositories (an installation was deleted, or they were taken off it, ROADMAP 1a.6):
   * every connection **through the App** to one of them, whoever's it is, is disconnected as the person disconnecting it would, with
   * its drafts, shares and comments. A connection by token to the same repository is not the App's to end. Says how many went.
   */
  async accessRemoved(repositories: RepositoryRef[]): Promise<number> {
    let removed = 0;
    for (const ref of repositories) {
      const rows = await dbAll<{ id: number; accountId: string }>(
        this.database,
        sql`SELECT id, account_id AS "accountId" FROM ${table(this.database)} WHERE provider = 'github' AND kind = 'app' AND owner = ${ref.owner} AND name = ${ref.name}`,
      );
      for (const row of rows) if (await this.remove(row.accountId, Number(row.id))) removed++;
    }
    return removed;
  }

  /**
   * A branch of a repository moved (a `push` webhook, ROADMAP 1a.6): forget the trees kept for every connection to it that follows that
   * branch, whoever's it is, so the next view reads the repository as it now is. Says how many connections it was. A tree is kept by
   * commit and is never stale, so this costs one read and keeps a repository from holding trees for commits that are gone.
   */
  async pushed(ref: RepositoryRef, branch: string): Promise<number> {
    const rows = await dbAll<{ id: number }>(
      this.database,
      sql`SELECT id FROM ${table(this.database)} WHERE provider = 'github' AND owner = ${ref.owner} AND name = ${ref.name} AND branch = ${branch}`,
    );
    for (const row of rows) await dbRun(this.database, sql`DELETE FROM ${trees(this.database)} WHERE connection_id = ${Number(row.id)}`);
    return rows.length;
  }

  // --- Repositories on this server (ROADMAP 3i) ---------------------------------------------

  /** The server-side provider for one account: its repositories only, with this instance's limits. */
  localProvider(accountId: string): LocalProvider {
    return new LocalProvider({ database: this.database, accountId, limits: this.limits, restoreWindowMs: restoreWindowMs(), now: this.now });
  }

  /** What an account holds on this server and what it may (`src/local/limits.ts`), for the page that says how much is used. */
  async localUsage(accountId: string): Promise<LocalUsage> {
    return { ...(await this.localProvider(accountId).usage()), limits: this.limits };
  }

  /**
   * A new repository on this server, with `files` as its first commit, connected like any other: the same connection row, which a later
   * sync turns into a GitHub one. Refused with a `ConnectionError` saying which limit was reached, or why the name cannot be used. Nothing
   * is left of one that failed.
   */
  async addLocal(accountId: string, input: { name: string; files: Record<string, Uint8Array> }): Promise<ConnectionInfo> {
    const local = this.localProvider(accountId);
    const name = input.name.trim();
    if (name === "") throw new ConnectionError("invalid_name", "Give the repository a name.");
    if (!validRepositoryName(name)) throw new ConnectionError("invalid_name", "That name cannot be used. Keep it to 64 characters, with no slashes, and not starting with a dot.");
    let ref: RepositoryRef;
    try {
      ref = await local.create(name, input.files);
    } catch (error) {
      if (isProviderError(error, "limit_reached")) throw new ConnectionError("limit_reached", error.message);
      if (isProviderError(error, "invalid_request")) throw new ConnectionError("invalid_name", `You already have a repository called “${name}”.`);
      throw error;
    }
    try {
      const rows = await dbAll<Row>(
        this.database,
        sql`INSERT INTO ${table(this.database)} (account_id, provider, kind, owner, name, branch, credential_id, created_at, public_id)
            VALUES (${accountId}, 'local', 'local', ${LOCAL_OWNER}, ${ref.name}, ${LOCAL_BRANCH}, '', ${this.now()}, ${await this.freshPublicId()})
            RETURNING ${COLUMNS}`,
      );
      const row = rows[0] as Row;
      return toInfo(row, await this.defaultIfNone(accountId, Number(row.id)));
    } catch (error) {
      await local.destroy(ref);
      throw error;
    }
  }

  /**
   * The last step of a sync (`src/local/sync.ts`), once the files are in the git repository and have been checked to be: switch this
   * connection to it and delete what the server held. **The server's copy is deleted only here, after the connection has the repository,
   * and only if nothing was committed to it since `expectedHead`**: the branch is frozen (moved to a commit nothing else is at) with one
   * statement that checks the head, so an edit that lands meanwhile is refused (`head_moved`) and not lost, and a sync that cannot go
   * on puts the branch back. Safe to run again after any part of it: a connection that is already GitHub's is reported as done.
   */
  async finishSync(accountId: string, id: number, target: { ref: RepositoryRef; branch: string; token: string }, expectedHead: string): Promise<ConnectionInfo> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    if (!row) throw new ConnectionError("not_found", "That repository is not connected.");
    const was = { owner: row.owner, name: row.name, branch: row.branch };
    if (row.provider !== "local") return toInfo(row, (await this.defaultFor(accountId))?.id === id);
    const local = this.localProvider(accountId);
    if (!(await local.freeze({ owner: was.owner, name: was.name }, was.branch, expectedHead))) {
      throw new ConnectionError("head_moved", "This repository was changed while its files were being moved. Nothing was lost: try again and the new changes go too.");
    }
    const credentialId = await this.credentials.put(PURPOSE, target.token, this.now());
    try {
      const updated = await dbAll<{ id: number }>(
        this.database,
        sql`UPDATE ${table(this.database)} SET provider = 'github', kind = 'pat', owner = ${target.ref.owner}, name = ${target.ref.name}, branch = ${target.branch}, credential_id = ${credentialId}
            WHERE id = ${id} AND account_id = ${accountId} AND provider = 'local' RETURNING id`,
      );
      if (updated.length === 0) throw new ConnectionError("not_found", "That repository is not connected.");
    } catch (error) {
      // The files stay where they are, writable again, and nothing keeps a token that no connection has.
      await local.thaw({ owner: was.owner, name: was.name }, was.branch, expectedHead).catch(() => undefined);
      await this.credentials.remove(credentialId);
      throw error;
    }
    // The connection is GitHub's now; this is housekeeping, and a run that stops here is finished by the next sync of nothing: the
    // rows are of a repository no connection reaches, and `destroy` can be run again.
    await local.destroy({ owner: was.owner, name: was.name });
    await dbRun(this.database, sql`DELETE FROM ${trees(this.database)} WHERE connection_id = ${id}`);
    const done = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id}`);
    return toInfo(done as Row, (await this.defaultFor(accountId))?.id === id);
  }

  private async storedDefault(accountId: string): Promise<number | undefined> {
    const row = await dbGet<{ connectionId: number | string }>(
      this.database,
      sql`SELECT connection_id AS "connectionId" FROM ${defaults(this.database)} WHERE account_id = ${accountId}`,
    );
    return row ? Number(row.connectionId) : undefined;
  }

  private effectiveDefault(rows: Row[], stored: number | undefined): number | undefined {
    if (stored !== undefined && rows.some((row) => Number(row.id) === stored)) return stored;
    return rows[0] ? Number(rows[0].id) : undefined;
  }

  private async writeDefault(accountId: string, id: number): Promise<void> {
    await dbRun(
      this.database,
      sql`INSERT INTO ${defaults(this.database)} (account_id, connection_id, updated_at) VALUES (${accountId}, ${id}, ${this.now()})
          ON CONFLICT (account_id) DO UPDATE SET connection_id = ${id}, updated_at = ${this.now()}`,
    );
  }

  /** Make a new connection the default if it is the account's first; says whether it is now. */
  private async defaultIfNone(accountId: string, id: number): Promise<boolean> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE account_id = ${accountId} ORDER BY id ASC`);
    // Only when it is the account's only connection: otherwise the account already has a default, chosen or not.
    if (rows.some((row) => Number(row.id) !== id)) return false;
    await this.writeDefault(accountId, id);
    return true;
  }

  private async find(accountId: string, ref: RepositoryRef): Promise<boolean> {
    const row = await dbGet<{ id: number }>(
      this.database,
      sql`SELECT id FROM ${table(this.database)} WHERE account_id = ${accountId} AND provider = 'github' AND owner = ${ref.owner} AND name = ${ref.name}`,
    );
    return row !== undefined;
  }

  /**
   * The default branch of a repository that exists is always there, unless nothing has ever been
   * committed to it: so a branch that is "not found" here is an empty repository, and is said to be.
   */
  private async headOf(provider: Provider, ref: RepositoryRef, branch: string): Promise<string> {
    try {
      const result = await provider.getHead(ref, branch);
      // Asked without an etag, so it is always the head itself.
      return result.changed ? result.head.commit : "";
    } catch (error) {
      if (isProviderError(error, "not_found")) throw empty(ref);
      throw explainProviderError(error, ref);
    }
  }

  private async warnings(provider: Provider, ref: RepositoryRef): Promise<string[]> {
    try {
      const others = (await provider.listRepositories()).filter((repo) => repositoryKey(repo.ref).toLowerCase() !== repositoryKey(ref).toLowerCase());
      if (others.length === 0) return [];
      return [
        `This token can also reach ${others.length} other ${others.length === 1 ? "repository" : "repositories"}. A token limited to just ${repositoryKey(ref)} is safer: if it ever leaks, it can reach only this.`,
      ];
    } catch {
      return [];
    }
  }

  /** Run a call to the host, and say what went wrong in our words. */
  private async asked<T>(call: () => Promise<T>, ref: RepositoryRef): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw explainProviderError(error, ref);
    }
  }
}

function cleanToken(raw: string): string {
  const token = raw.trim();
  if (token === "") throw new ConnectionError("invalid_token", "Enter the access token.");
  if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new ConnectionError("invalid_token", "That does not look like an access token. Copy it again, all of it and nothing else.");
  }
  return token;
}

const empty = (ref: RepositoryRef) =>
  new ConnectionError("empty_repository", `${repositoryKey(ref)} is empty. Add a first file to it (a README will do) and try again.`);

/** What a host's failure is told as, in our words (a `ConnectionError`), or the error itself when it is not one a person can act on. */
export function explainProviderError(error: unknown, ref: RepositoryRef): unknown {
  if (error instanceof ConnectionError) return error;
  if (!isProviderError(error)) return error;
  switch (error.code) {
    case "unauthorized":
      return new ConnectionError("bad_token", "GitHub did not accept that token. Check that it was copied whole, and that it has not expired or been revoked.");
    case "not_found":
      return new ConnectionError("not_found", `GitHub cannot find ${repositoryKey(ref)} with that token. Check the address, and that the token was given access to this repository.`);
    case "forbidden":
      return new ConnectionError("forbidden", `GitHub would not let that token read ${repositoryKey(ref)}. If the repository belongs to an organisation, the token may need the organisation's approval.`);
    case "empty_repository":
      return empty(ref);
    case "rate_limited":
      return new ConnectionError("rate_limited", "GitHub is limiting requests right now. Try again in a minute.");
    case "unavailable":
      return new ConnectionError("unavailable", "Could not reach GitHub. Try again in a moment.");
    default:
      return error;
  }
}
