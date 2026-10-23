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
const COLUMNS = sql.raw('id, owner, name, branch, created_at AS "createdAt", credential_id AS "credentialId"');

interface Row {
  id: number;
  owner: string;
  name: string;
  branch: string;
  createdAt: number;
  credentialId: string;
}

const toInfo = (row: Row): ConnectionInfo => ({
  id: Number(row.id),
  provider: "github",
  kind: "pat",
  owner: row.owner,
  name: row.name,
  branch: row.branch,
  createdAt: Number(row.createdAt),
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
      return { connection: toInfo(rows[0] as Row), warnings };
    } catch (error) {
      // Nothing may be left holding a token that no connection points to.
      await this.credentials.remove(credentialId);
      throw error;
    }
  }

  async list(accountId: string): Promise<ConnectionInfo[]> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE account_id = ${accountId} ORDER BY id ASC`);
    return rows.map(toInfo);
  }

  async get(accountId: string, id: number): Promise<ConnectionInfo | undefined> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    return row ? toInfo(row) : undefined;
  }

  /** Disconnect: the connection and its token are deleted. False if it is not this account's (or not there). */
  async remove(accountId: string, id: number): Promise<boolean> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    if (!row) return false;
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    await this.credentials.remove(row.credentialId);
    return true;
  }

  /**
   * A provider for one of this account's connections, with its token decrypted, for the server to use
   * and for nothing else: the token goes into the provider and is not returned.
   */
  async provider(accountId: string, id: number): Promise<{ provider: Provider; connection: ConnectionInfo } | undefined> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE id = ${id} AND account_id = ${accountId}`);
    if (!row) return undefined;
    const { secret } = await this.credentials.get(row.credentialId);
    return { provider: this.github(secret), connection: toInfo(row) };
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
