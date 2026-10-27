import { sql } from "drizzle-orm";
import type { CredentialStore } from "../crypto/store";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { isProviderError } from "../providers/errors";
import { type Provider, type RepositoryRef, repositoryKey } from "../providers/types";
import { ConnectionError } from "./errors";
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
  provider: "github";
  kind: "pat";
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
}

export interface Added {
  connection: ConnectionInfo;
  /** Things worth telling the person that did not stop it, e.g. a token that reaches more than it needs to. */
  warnings: string[];
}

export interface ConnectionServiceOptions {
  database: Database;
  credentials: CredentialStore;
  /** A provider for GitHub with this personal access token. */
  github: (token: string) => Provider;
  /** For tests. */
  now?: () => number;
}

const PURPOSE = "github-pat";
const MAX_TOKEN_LENGTH = 1000;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.connection : sqliteSchema.connection);
const trees = (database: Database) => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);
const drafts = (database: Database) => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);
const docIndex = (database: Database) => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const userShares = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);
const linkShares = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);
const commentTables = (database: Database) => (database.dialect === "postgres" ? [postgresSchema.commentReply, postgresSchema.commentThread, postgresSchema.commentActivity, postgresSchema.commentClosed] : [sqliteSchema.commentReply, sqliteSchema.commentThread, sqliteSchema.commentActivity, sqliteSchema.commentClosed]);
const deletions = (database: Database) => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);
const defaults = (database: Database) => (database.dialect === "postgres" ? postgresSchema.accountDefault : sqliteSchema.accountDefault);
const COLUMNS = sql.raw('id, owner, name, branch, created_at AS "createdAt", credential_id AS "credentialId", default_vault AS "defaultVault"');

interface Row {
  id: number;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
  credentialId: string;
  defaultVault: string | null;
}

const toInfo = (row: Row, isDefault: boolean): ConnectionInfo => ({
  id: Number(row.id),
  provider: "github",
  kind: "pat",
  owner: row.owner,
  name: row.name,
  branch: row.branch,
  createdAt: Number(row.createdAt),
  isDefault,
  defaultVault: row.defaultVault ?? null,
});

export class ConnectionService {
  private readonly database: Database;
  private readonly credentials: CredentialStore;
  private readonly github: (token: string) => Provider;
  private readonly now: () => number;

  constructor(options: ConnectionServiceOptions) {
    this.database = options.database;
    this.credentials = options.credentials;
    this.github = options.github;
    this.now = options.now ?? Date.now;
  }

  /** Check a token against a repository and, if it is good for Fjord, keep both. */
  async addWithToken(accountId: string, input: { repository: string; token: string }): Promise<Added> {
    const wanted = parseRepository(input.repository);
    const token = cleanToken(input.token);
    const provider = this.github(token);

    // Each step is the first thing that would go wrong for a person, in the order they would fix it.
    const repository = await this.asked(() => provider.getRepository(wanted), wanted);
    const ref = repository.ref;
    const branch = repository.defaultBranch;
    await this.headOf(provider, ref, branch);

    if (await this.find(accountId, ref)) {
      throw new ConnectionError("already_connected", `${repositoryKey(ref)} is already connected.`);
    }
    if (!(await this.asked(() => provider.canWrite(ref, branch), ref))) {
      throw new ConnectionError(
        "read_only",
        "That token can read this repository but not write to it. Create the token with the repository permission “Contents: Read and write”, and try again.",
      );
    }

    const warnings = await this.warnings(provider, ref);

    const credentialId = await this.credentials.put(PURPOSE, token, this.now());
    try {
      const rows = await dbAll<Row>(
        this.database,
        sql`INSERT INTO ${table(this.database)} (account_id, provider, kind, owner, name, branch, credential_id, created_at)
            VALUES (${accountId}, 'github', 'pat', ${ref.owner}, ${ref.name}, ${branch}, ${credentialId}, ${this.now()})
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
    const chosen = this.effectiveDefault(rows, await this.storedDefault(accountId));
    return rows.map((row) => toInfo(row, Number(row.id) === chosen));
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
  async setDefaultVault(accountId: string, id: number, vault: string | null): Promise<boolean> {
    if (!(await this.get(accountId, id))) return false;
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET default_vault = ${vault} WHERE id = ${id} AND account_id = ${accountId}`);
    return true;
  }

  /** Disconnect: the connection and its token are deleted. False if it is not this account's (or not there). */
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
    // And what was shared from it: the documents are not reachable any more.
    await dbRun(this.database, sql`DELETE FROM ${userShares(this.database)} WHERE connection_id = ${id}`);
    await dbRun(this.database, sql`DELETE FROM ${linkShares(this.database)} WHERE connection_id = ${id}`);
    // And what was said about its documents.
    for (const comments of commentTables(this.database)) await dbRun(this.database, sql`DELETE FROM ${comments} WHERE connection_id = ${id}`);
    await this.credentials.remove(row.credentialId);
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
    const { secret } = await this.credentials.get((row as Row).credentialId);
    return { provider: this.github(secret), connection };
  }

  /**
   * A provider for a connection **on behalf of a share** (ROADMAP 1c.2): the owner's token, to read the one document that was
   * shared, for a person who has no connection of their own. It does not check who is asking, so it is only called after a
   * share was found for them, and what it reads is that document and nothing the share does not name.
   */
  async providerForShare(id: number): Promise<{ provider: Provider; id: number; ref: { owner: string; name: string }; branch: string; ownerId: string } | undefined> {
    const row = await dbGet<Row & { accountId: string }>(this.database, sql`SELECT ${COLUMNS}, account_id AS "accountId" FROM ${table(this.database)} WHERE id = ${id}`);
    if (!row) return undefined;
    const { secret } = await this.credentials.get(row.credentialId);
    return { provider: this.github(secret), id, ref: { owner: row.owner, name: row.name }, branch: row.branch, ownerId: row.accountId };
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
  private async headOf(provider: Provider, ref: RepositoryRef, branch: string): Promise<void> {
    try {
      await provider.getHead(ref, branch);
    } catch (error) {
      if (isProviderError(error, "not_found")) throw empty(ref);
      throw explain(error, ref);
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
      throw explain(error, ref);
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

function explain(error: unknown, ref: RepositoryRef): unknown {
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
