import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";

/**
 * Which Doc is at which path (DESIGN.md §9, §14, ROADMAP 1b.6): the store behind `/doc/<id>` and `/note/<id>`. It records
 * what was read, with the blob it was read at, and is believed only where that blob is still the repository's (`ids.ts`).
 * `docId` is null for a Markdown file that was read and has no valid `id`: knowing that is as useful as knowing an id,
 * because the file is then not read again until it changes.
 */
export interface IndexedFile {
  path: string;
  docId: string | null;
  kind: "note" | "document";
  blob: string;
}

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.docIndex : sqliteSchema.docIndex);
const COLUMNS = sql.raw('path, doc_id AS "docId", kind, blob');
/** Rows per insert: well under the limit on bound values either database has. */
const BATCH = 200;

interface Row {
  path: string;
  docId: string | null;
  kind: string;
  blob: string;
}

const toFile = (row: Row): IndexedFile => ({ path: row.path, docId: row.docId ?? null, kind: row.kind === "document" ? "document" : "note", blob: row.blob });

export class DocIndex {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every file of a connection that has been read, by path. */
  async all(connectionId: number): Promise<Map<string, IndexedFile>> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
    return new Map(rows.map((row) => [row.path, toFile(row)]));
  }

  /** The files these connections have with this `id`, as last read: the connection's id and the file. */
  async find(connectionIds: number[], docId: string): Promise<{ connectionId: number; file: IndexedFile }[]> {
    if (connectionIds.length === 0) return [];
    const rows = await dbAll<Row & { connectionId: number | string }>(
      this.database,
      sql`SELECT connection_id AS "connectionId", ${COLUMNS} FROM ${table(this.database)}
          WHERE doc_id = ${docId} AND connection_id IN (${sql.join(connectionIds.map((id) => sql`${id}`), sql`, `)})
          ORDER BY connection_id ASC, path ASC`,
    );
    return rows.map((row) => ({ connectionId: Number(row.connectionId), file: toFile(row) }));
  }

  /** Record what was read, replacing what was recorded for those paths. */
  async put(connectionId: number, files: IndexedFile[]): Promise<void> {
    const at = this.now();
    for (let start = 0; start < files.length; start += BATCH) {
      const rows = files.slice(start, start + BATCH).map((file) => sql`(${connectionId}, ${file.path}, ${file.docId}, ${file.kind}, ${file.blob}, ${at})`);
      await dbRun(
        this.database,
        sql`INSERT INTO ${table(this.database)} (connection_id, path, doc_id, kind, blob, indexed_at)
            VALUES ${sql.join(rows, sql`, `)}
            ON CONFLICT (connection_id, path) DO UPDATE SET doc_id = excluded.doc_id, kind = excluded.kind, blob = excluded.blob, indexed_at = excluded.indexed_at`,
      );
    }
  }

  /** Forget these paths: they are not in the repository any more. */
  async remove(connectionId: number, paths: string[]): Promise<void> {
    for (let start = 0; start < paths.length; start += BATCH) {
      const some = paths.slice(start, start + BATCH);
      await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path IN (${sql.join(some.map((path) => sql`${path}`), sql`, `)})`);
    }
  }

  /** Everything of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
