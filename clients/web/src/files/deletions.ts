import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";

/**
 * What was deleted through the app (DESIGN.md §8, ROADMAP 1b.12), so that it can be put back. Git keeps the file in its
 * history, which is why nothing is lost; this is how the app finds it again, and for how long it offers to: `list` takes a
 * window, and a deletion older than that is not shown (the row stays; the history does).
 *
 * One row per file. A folder is deleted as its files, with one deleting commit, which is what ties them together.
 */
export interface DeletionRecord {
  id: number;
  /** Where it was, repository-relative. */
  path: string;
  /** The Doc's `id`, when it was read; null otherwise. */
  docId: string | null;
  kind: "note" | "document" | "other";
  /** Its last blob. */
  blob: string;
  deletingCommit: string;
  deletedBy: string;
  deletedAt: number;
  restoredAt: number | null;
}

export interface NewDeletion {
  path: string;
  kind: DeletionRecord["kind"];
  blob: string;
  docId?: string | null | undefined;
}

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.deletion : sqliteSchema.deletion);
const COLUMNS = sql.raw(
  'id, path, doc_id AS "docId", kind, blob, deleting_commit AS "deletingCommit", deleted_by AS "deletedBy", deleted_at AS "deletedAt", restored_at AS "restoredAt"',
);
/** Rows per insert: well under the limit on bound values either database has. */
const BATCH = 200;
/** The most that is listed at once. */
export const MAX_LISTED = 1000;

interface Row {
  id: number | string;
  path: string;
  docId: string | null;
  kind: string;
  blob: string;
  deletingCommit: string;
  deletedBy: string;
  deletedAt: number | string;
  restoredAt: number | string | null;
}

const toRecord = (row: Row): DeletionRecord => ({
  id: Number(row.id),
  path: row.path,
  docId: row.docId ?? null,
  kind: row.kind as DeletionRecord["kind"],
  blob: row.blob,
  deletingCommit: row.deletingCommit,
  deletedBy: row.deletedBy,
  deletedAt: Number(row.deletedAt),
  restoredAt: row.restoredAt === null ? null : Number(row.restoredAt),
});

export class DeletionService {
  private readonly now: () => number;

  constructor(
    private readonly database: Database,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Remember that these files were deleted by this commit. Their ids, in the order given. */
  async record(connectionId: number, commit: string, accountId: string, entries: NewDeletion[]): Promise<number[]> {
    const at = this.now();
    const ids: number[] = [];
    for (let start = 0; start < entries.length; start += BATCH) {
      const rows = entries
        .slice(start, start + BATCH)
        .map((entry) => sql`(${connectionId}, ${entry.path}, ${entry.docId ?? null}, ${entry.kind}, ${entry.blob}, ${commit}, ${accountId}, ${at})`);
      const inserted = await dbAll<{ id: number | string }>(
        this.database,
        sql`INSERT INTO ${table(this.database)} (connection_id, path, doc_id, kind, blob, deleting_commit, deleted_by, deleted_at)
            VALUES ${sql.join(rows, sql`, `)}
            RETURNING id`,
      );
      ids.push(...inserted.map((row) => Number(row.id)).sort((a, b) => a - b));
    }
    return ids;
  }

  /** The deletions not yet put back, newest first, within the last `windowMs`. */
  async list(connectionId: number, windowMs: number): Promise<DeletionRecord[]> {
    const rows = await dbAll<Row>(
      this.database,
      sql`SELECT ${COLUMNS} FROM ${table(this.database)}
          WHERE connection_id = ${connectionId} AND restored_at IS NULL AND deleted_at >= ${this.now() - windowMs}
          ORDER BY deleted_at DESC, id ASC
          LIMIT ${MAX_LISTED}`,
    );
    return rows.map(toRecord);
  }

  /** These deletions of this connection, whatever their state. Ids that are not the connection's are not there. */
  async get(connectionId: number, ids: number[]): Promise<DeletionRecord[]> {
    if (ids.length === 0) return [];
    const rows = await dbAll<Row>(
      this.database,
      sql`SELECT ${COLUMNS} FROM ${table(this.database)}
          WHERE connection_id = ${connectionId} AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          ORDER BY id ASC`,
    );
    return rows.map(toRecord);
  }

  /** Mark these as put back; the ones that were not already. Their ids. */
  async markRestored(connectionId: number, ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await dbAll<{ id: number | string }>(
      this.database,
      sql`UPDATE ${table(this.database)} SET restored_at = ${this.now()}
          WHERE connection_id = ${connectionId} AND restored_at IS NULL AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          RETURNING id`,
    );
    return rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  }

  /** Every record of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
