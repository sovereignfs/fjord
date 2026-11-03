import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { hashToken, newToken } from "../sharing/tokens";

/**
 * The pages published from a repository (DESIGN.md §12, ROADMAP 3h.1): a Doc by its connection and `id`, and the hash of the token in its address. At most one
 * address per Doc: publishing again makes a new one and the old one stops. The token is returned once, from `publish`, and is in no other answer.
 */
const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.publication : sqliteSchema.publication);

/** The key a file of an encrypted vault is published under: its path, which cannot be mistaken for a Doc `id`. */
export const copyKey = (path: string): string => `file:${path}`;

export class PublicationService {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
    private readonly random?: (size: number) => Buffer,
  ) {}

  /** Publish a Doc, ending any address it had. The token is the address's secret: it is shown once and not kept. */
  async publish(connectionId: number, docId: string, accountId: string): Promise<{ token: string }> {
    const token = newToken(this.random);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, created_by, created_at) VALUES (${connectionId}, ${docId}, ${hashToken(token)}, ${accountId}, ${this.now()})`,
    );
    return { token };
  }

  /** Whether a Doc is published, and since when. Never the token. */
  async status(connectionId: number, docId: string): Promise<{ publishedAt: number } | undefined> {
    const row = await dbGet<{ createdAt: number | string }>(this.database, sql`SELECT created_at AS "createdAt" FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return row ? { publishedAt: Number(row.createdAt) } : undefined;
  }

  /** End a Doc's address at once. Whether there was one. */
  async unpublish(connectionId: number, docId: string): Promise<boolean> {
    const was = await this.status(connectionId, docId);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return was !== undefined;
  }

  /**
   * The Doc a token is the address of, or nothing: never made, or ended. A page published from an encrypted vault (`publishCopy`) comes with the copy that was
   * handed over, since the server cannot read the file.
   */
  async find(token: string): Promise<{ connectionId: number; docId: string; copy?: { title: string; body: string } } | undefined> {
    const row = await dbGet<{ connectionId: number | string; docId: string; title: string | null; body: string | null }>(
      this.database,
      sql`SELECT connection_id AS "connectionId", doc_id AS "docId", title, body FROM ${table(this.database)} WHERE token_hash = ${hashToken(token)}`,
    );
    if (!row) return undefined;
    const found = { connectionId: Number(row.connectionId), docId: row.docId };
    return row.body === null ? found : { ...found, copy: { title: row.title ?? "", body: row.body } };
  }

  /**
   * Publish a **copy** of a file of an encrypted vault (ROADMAP 3h.2): its title and Markdown, in the clear, as the owner's browser decrypted them and chose to hand
   * over. The server holds no key and reads nothing of the file; the copy is kept until it is unpublished, and a later version is published again. Ends any address
   * the file had.
   */
  async publishCopy(connectionId: number, path: string, accountId: string, copy: { title: string; body: string }): Promise<{ token: string }> {
    const token = newToken(this.random);
    const key = copyKey(path);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${key}`);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, created_by, created_at, title, body) VALUES (${connectionId}, ${key}, ${hashToken(token)}, ${accountId}, ${this.now()}, ${copy.title}, ${copy.body})`,
    );
    return { token };
  }
}
