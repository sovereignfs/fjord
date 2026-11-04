import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { waitAfter } from "../sharing/password";
import type { CredentialStore } from "../crypto/store";
import { hashToken, newToken } from "../sharing/tokens";

/**
 * The pages published from a repository (DESIGN.md §12, ROADMAP 3h.1): a Doc by its connection and `id`, and the hash of the token in its address. At most one
 * address per Doc: publishing again makes a new one and the old one stops. The token is returned once, from `publish`, and is in no other answer.
 */
const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication);

/** The key a file of an encrypted vault is published under: its path, which cannot be mistaken for a Doc `id`. */
export const copyKey = (path: string): string => `file:${path}`;

/** Who may comment on a published page. Only `off` is built; the others are kept so that comments can be added to a page without changing what a publication is. */
export const COMMENT_MODES = ["off", "anyone", "users"] as const;
export type CommentMode = (typeof COMMENT_MODES)[number];
export const isCommentMode = (value: unknown): value is CommentMode => typeof value === "string" && (COMMENT_MODES as readonly string[]).includes(value);

/** How a page is published: an optional password, as its Argon2id hash (made by the caller, which hashes it once), and who may comment. */
export interface PublishSettings {
  passwordHash?: string | null;
  comments?: CommentMode;
}

/** What a page is, for the owner who looks: never the token, never the hash. */
export interface PublicationStatus {
  publishedAt: number;
  passwordProtected: boolean;
  comments: CommentMode;
}

/** What opening a page needs and a status must not show: the password's hash, and where the tries at it stand. */
export interface FoundPublication {
  id: number;
  connectionId: number;
  docId: string;
  createdBy: string;
  createdAt: number;
  passwordHash: string | null;
  comments: CommentMode;
  copy?: { title: string; body: string };
}

/** What the address of a page is sealed as in the credential store. */
export const TOKEN_PURPOSE = "publication-token";

/** The part of the credential store a publication uses: with it, a page's address is kept (sealed) and can be shown to its owner again; without it, it is shown once. */
export type TokenVault = Pick<CredentialStore, "put" | "get" | "remove">;

export class PublicationService {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
    private readonly random?: (size: number) => Buffer,
    private readonly vault?: TokenVault,
  ) {}

  /** Keep a page's address, sealed; the id to put in its row, or null when there is no vault to keep it in. */
  private async keep(token: string): Promise<string | null> {
    return this.vault ? this.vault.put(TOKEN_PURPOSE, token, this.now()) : null;
  }

  /** Forget the sealed address of what is about to be replaced or ended (a row that has none, or a vault that is not there, has nothing to forget). */
  private async forget(where: ReturnType<typeof sql>): Promise<void> {
    if (!this.vault) return;
    const rows = await dbAll<{ id: string | null }>(this.database, sql`SELECT token_credential AS id FROM ${table(this.database)} WHERE ${where}`);
    for (const row of rows) if (row.id) await this.vault.remove(row.id);
  }

  /** The address of a page, to show its owner again: undefined for a page whose address was not kept (made before it was, or with no key), or one that cannot be opened now. */
  async address(connectionId: number, docId: string): Promise<string | undefined> {
    if (!this.vault) return undefined;
    const row = await dbGet<{ id: string | null; tokenHash: string }>(this.database, sql`SELECT token_credential AS id, token_hash AS "tokenHash" FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    if (!row?.id) return undefined;
    try {
      const { secret } = await this.vault.get(row.id);
      // What is returned is the address the hash is of, and nothing else.
      return hashToken(secret) === row.tokenHash ? secret : undefined;
    } catch {
      return undefined;
    }
  }

  /** Publish a Doc, ending any address it had. The token is the address's secret: it is shown once and not kept. */
  async publish(connectionId: number, docId: string, accountId: string, settings: PublishSettings = {}): Promise<{ token: string }> {
    const token = newToken(this.random);
    await this.forget(sql`connection_id = ${connectionId} AND doc_id = ${docId}`);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, created_by, created_at, password_hash, comments, token_credential) VALUES (${connectionId}, ${docId}, ${hashToken(token)}, ${accountId}, ${this.now()}, ${settings.passwordHash ?? null}, ${settings.comments ?? "off"}, ${await this.keep(token)})`,
    );
    return { token };
  }

  /**
   * Change how a published page is open without changing its address: its password (a hash to set, `null` to take it off, absent to keep it) and who may comment. A new password ends
   * every cookie given for the old one, which are bound to the hash. Whether there was a page.
   */
  async update(connectionId: number, docId: string, settings: PublishSettings): Promise<boolean> {
    const was = await this.status(connectionId, docId);
    if (!was) return false;
    if (settings.passwordHash !== undefined) {
      await dbRun(this.database, sql`UPDATE ${table(this.database)} SET password_hash = ${settings.passwordHash}, failures = 0, locked_until = NULL WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    }
    if (settings.comments !== undefined) {
      await dbRun(this.database, sql`UPDATE ${table(this.database)} SET comments = ${settings.comments} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    }
    return true;
  }

  /** Whether a Doc is published, and since when. Never the token. */
  async status(connectionId: number, docId: string): Promise<PublicationStatus | undefined> {
    const row = await dbGet<{ createdAt: number | string; hasPassword: number | string | boolean; comments: string }>(
      this.database,
      sql`SELECT created_at AS "createdAt", CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS "hasPassword", comments FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`,
    );
    return row ? { publishedAt: Number(row.createdAt), passwordProtected: row.hasPassword === true || Number(row.hasPassword) === 1, comments: isCommentMode(row.comments) ? row.comments : "off" } : undefined;
  }

  /** End a Doc's address at once. Whether there was one. */
  async unpublish(connectionId: number, docId: string): Promise<boolean> {
    const was = await this.status(connectionId, docId);
    await this.forget(sql`connection_id = ${connectionId} AND doc_id = ${docId}`);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return was !== undefined;
  }

  /**
   * The page a token is the address of, or nothing: never made, or ended. A page published from an encrypted vault (`publishCopy`) comes with the copy that was
   * handed over, since the server cannot read the file.
   */
  async find(token: string): Promise<FoundPublication | undefined> {
    const row = await dbGet<{ id: number | string; connectionId: number | string; docId: string; createdBy: string; createdAt: number | string; title: string | null; body: string | null; passwordHash: string | null; comments: string }>(
      this.database,
      sql`SELECT id, connection_id AS "connectionId", doc_id AS "docId", created_by AS "createdBy", created_at AS "createdAt", title, body, password_hash AS "passwordHash", comments FROM ${table(this.database)} WHERE token_hash = ${hashToken(token)}`,
    );
    if (!row) return undefined;
    const found: FoundPublication = {
      id: Number(row.id),
      connectionId: Number(row.connectionId),
      docId: row.docId,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      passwordHash: row.passwordHash,
      comments: isCommentMode(row.comments) ? row.comments : "off",
    };
    return row.body === null ? found : { ...found, copy: { title: row.title ?? "", body: row.body } };
  }

  /**
   * Take the right to try a password. Tries are one at a time and slow down: a try **claims** the page's next turn in a single statement that only one of several at once can win, and
   * each claim makes the next wait (`waitAfter` the failures so far). A try that cannot be claimed is not checked at all.
   */
  async claimTry(id: number): Promise<{ claimed: true } | { claimed: false; retryAt: number }> {
    const now = this.now();
    const state = await dbGet<{ failures: number | string }>(this.database, sql`SELECT failures FROM ${table(this.database)} WHERE id = ${id}`);
    if (!state) return { claimed: false, retryAt: now };
    const won = await dbAll<{ id: number }>(
      this.database,
      sql`UPDATE ${table(this.database)} SET locked_until = ${now + waitAfter(Number(state.failures))} WHERE id = ${id} AND (locked_until IS NULL OR locked_until <= ${now}) RETURNING id`,
    );
    if (won.length > 0) return { claimed: true };
    const lock = await dbGet<{ lockedUntil: number | string | null }>(this.database, sql`SELECT locked_until AS "lockedUntil" FROM ${table(this.database)} WHERE id = ${id}`);
    return { claimed: false, retryAt: lock?.lockedUntil == null ? now : Number(lock.lockedUntil) };
  }

  /** A wrong password: one more failure, and the next try waits as long as that many failures ask. */
  async recordFailure(id: number): Promise<void> {
    const rows = await dbAll<{ failures: number | string }>(this.database, sql`UPDATE ${table(this.database)} SET failures = failures + 1 WHERE id = ${id} RETURNING failures`);
    const failures = Number(rows[0]?.failures ?? 0);
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET locked_until = ${this.now() + waitAfter(failures)} WHERE id = ${id}`);
  }

  /** The right password: the failures and the wait are forgotten. */
  async recordSuccess(id: number): Promise<void> {
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET failures = 0, locked_until = NULL WHERE id = ${id}`);
  }

  /**
   * Publish a **copy** of a file of an encrypted vault (ROADMAP 3h.2): its title and Markdown, in the clear, as the owner's browser decrypted them and chose to hand
   * over. The server holds no key and reads nothing of the file; the copy is kept until it is unpublished, and a later version is published again. Ends any address
   * the file had.
   */
  async publishCopy(connectionId: number, path: string, accountId: string, copy: { title: string; body: string }): Promise<{ token: string }> {
    const token = newToken(this.random);
    const key = copyKey(path);
    await this.forget(sql`connection_id = ${connectionId} AND doc_id = ${key}`);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${key}`);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, created_by, created_at, title, body, token_credential) VALUES (${connectionId}, ${key}, ${hashToken(token)}, ${accountId}, ${this.now()}, ${copy.title}, ${copy.body}, ${await this.keep(token)})`,
    );
    return { token };
  }
}
