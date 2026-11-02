import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import type { JournalEntrySummary } from "../format/types";

/**
 * What a plaintext journal's timeline knows of its entries (ROADMAP 3b.2, the `journal_entry` table): `fjord-core`'s summary of each,
 * by the blob and the path it was read at. A blob never changes, so a summary is never stale; one that matches no file of the head is
 * simply not asked for, and is let go by `retain`. Never written for an encrypted journal.
 */
const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.journalEntry : sqliteSchema.journalEntry);
const BATCH = 200;

export interface EntryKey {
  path: string;
  blob: string;
}

const keyOf = (key: EntryKey) => `${key.blob} ${key.path}`;

export class JournalIndex {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** The summaries known for these files, by `blob path`. */
  async get(connectionId: number, keys: EntryKey[]): Promise<Map<string, JournalEntrySummary>> {
    const wanted = new Set(keys.map(keyOf));
    const rows = await dbAll<{ path: string; blob: string; summary: string }>(this.database, sql`SELECT path, blob, summary FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
    const found = new Map<string, JournalEntrySummary>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!wanted.has(key)) continue;
      try {
        found.set(key, JSON.parse(row.summary) as JournalEntrySummary);
      } catch {
        // A row that is not what this version writes is read again.
      }
    }
    return found;
  }

  /** Record what was read. */
  async put(connectionId: number, entries: (EntryKey & { summary: JournalEntrySummary })[]): Promise<void> {
    const at = this.now();
    for (let start = 0; start < entries.length; start += BATCH) {
      const rows = entries.slice(start, start + BATCH).map((entry) => sql`(${connectionId}, ${entry.path}, ${entry.blob}, ${JSON.stringify(entry.summary)}, ${at})`);
      await dbRun(
        this.database,
        sql`INSERT INTO ${table(this.database)} (connection_id, path, blob, summary, indexed_at) VALUES ${sql.join(rows, sql`, `)}
            ON CONFLICT (connection_id, blob, path) DO UPDATE SET summary = excluded.summary, indexed_at = excluded.indexed_at`,
      );
    }
  }

  /** Let go of what is known of files that are not these: entries that were changed, moved or deleted since. */
  async retain(connectionId: number, keys: EntryKey[]): Promise<void> {
    const keep = new Set(keys.map(keyOf));
    const rows = await dbAll<{ id: number | string; path: string; blob: string }>(this.database, sql`SELECT id, path, blob FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
    const stale = rows.filter((row) => !keep.has(keyOf(row))).map((row) => Number(row.id));
    for (let start = 0; start < stale.length; start += BATCH) {
      const some = stale.slice(start, start + BATCH);
      await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND id IN (${sql.join(some.map((id) => sql`${id}`), sql`, `)})`);
    }
  }
}
