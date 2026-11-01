import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { TOKEN_PATTERN, hashToken, newToken } from "../sharing/tokens";

/**
 * Sealed copies of encrypted files, shared by link (DESIGN.md §12, ROADMAP 2c.1). The server holds a copy only as ciphertext it cannot read: the sharer's browser sealed
 * it, to a key that is in the link's `#fragment` (never sent to a server) or to a password. What is kept here is that, the token's SHA-256 (the token is shown once), and
 * enough to list a file's shares. **Revoking deletes the row**, so the copy is gone, not hidden. The token is the only way to a copy; whether a copy opens is the key's.
 */
export type SealedMode = "key" | "password";
export const MODES: readonly SealedMode[] = ["key", "password"];

export interface SealedRecord {
  id: number;
  connectionId: number;
  path: string;
  mode: SealedMode;
  createdAt: number;
}

/** What opening a link is given: how the copy is sealed and the copy itself. */
export interface SealedCopy {
  mode: SealedMode;
  /** The bytes the sharer's browser made, as base64. */
  ciphertext: string;
  createdAt: number;
}

export const MAX_SEALED_PER_FILE = 20;
export const MAX_SEALED_PER_CONNECTION = 200;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.sealedShare : sqliteSchema.sealedShare);
const COLUMNS = sql.raw('id, connection_id AS "connectionId", path, mode, created_at AS "createdAt"');

interface Row {
  id: number | string;
  connectionId: number | string;
  path: string;
  mode: string;
  createdAt: number | string;
}

const toRecord = (row: Row): SealedRecord => ({ id: Number(row.id), connectionId: Number(row.connectionId), path: row.path, mode: row.mode === "password" ? "password" : "key", createdAt: Number(row.createdAt) });

export type CreateResult = { ok: true; token: string; record: SealedRecord } | { ok: false; reason: "too_many_for_file" | "too_many" };

export class SealedShareService {
  constructor(
    private readonly database: Database,
    private readonly options: { now?: () => number; random?: (size: number) => Buffer } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Keep a sealed copy. The token is returned once; only its hash is kept. */
  async create(connectionId: number, input: { path: string; mode: SealedMode; ciphertext: string; createdBy: string }): Promise<CreateResult> {
    if ((await this.count(connectionId, input.path)) >= MAX_SEALED_PER_FILE) return { ok: false, reason: "too_many_for_file" };
    if ((await this.count(connectionId)) >= MAX_SEALED_PER_CONNECTION) return { ok: false, reason: "too_many" };
    const token = newToken(this.options.random);
    const now = this.now();
    const rows = await dbAll<Row>(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, path, token_hash, mode, ciphertext, created_by, created_at)
          VALUES (${connectionId}, ${input.path}, ${hashToken(token)}, ${input.mode}, ${input.ciphertext}, ${input.createdBy}, ${now})
          RETURNING ${COLUMNS}`,
    );
    return { ok: true, token, record: toRecord(rows[0] as Row) };
  }

  /** The copy a link's token opens, or nothing: the token is the only way in, and a revoked one finds nothing because the row is gone. */
  async byToken(token: string): Promise<SealedCopy | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const row = await dbGet<{ mode: string; ciphertext: string; createdAt: number | string }>(
      this.database,
      sql`SELECT mode, ciphertext, created_at AS "createdAt" FROM ${table(this.database)} WHERE token_hash = ${hashToken(token)}`,
    );
    return row ? { mode: row.mode === "password" ? "password" : "key", ciphertext: row.ciphertext, createdAt: Number(row.createdAt) } : undefined;
  }

  /** The shares of one file, newest first. Never the copy. */
  async list(connectionId: number, path: string): Promise<SealedRecord[]> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path} ORDER BY id DESC`);
    return rows.map(toRecord);
  }

  /** Delete the copy: after this nothing opens it, and nothing of it is kept. False if there was no such share of this connection. */
  async revoke(connectionId: number, id: number): Promise<boolean> {
    const rows = await dbAll<{ id: number }>(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND id = ${id} RETURNING id`);
    return rows.length > 0;
  }

  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }

  async count(connectionId: number, path?: string): Promise<number> {
    const row =
      path === undefined
        ? await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId}`)
        : await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path}`);
    return Number(row?.n ?? 0);
  }
}
