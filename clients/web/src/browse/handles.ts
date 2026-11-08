import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { dbAll, dbGet, dbRun } from '../db/exec';
import * as postgresSchema from '../db/schema/postgres';
import * as sqliteSchema from '../db/schema/sqlite';

/**
 * The opaque names in `/f/<handle>` (DESIGN.md §9, ROADMAP 3e.2, RFC 0002): the address of a file or a folder that has no Doc `id`, so that no address
 * shows a path. A handle is **derived data and never committed** (spec §2.2): it is made the first time a link is drawn to a path, kept here by
 * connection and path, and carried to the new path by Fjord's own rename and move. A file moved some other way leaves its handle on a path that is
 * not there, which the page says is moved or gone; a handle never leads to a different file than the one it was made for, because a path that is
 * taken again by another file is what its handle is of, and nothing else (a path is its identity).
 */
const table = (database: Database) =>
  database.dialect === 'postgres' ? postgresSchema.fileHandle : sqliteSchema.fileHandle;

/** Crockford's base32 in lower case, 16 characters: 80 random bits. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 16;

/** Whether a string can be a handle, before anything is looked up. */
export function isHandle(value: string): boolean {
  return value.length === LENGTH && [...value].every((character) => ALPHABET.includes(character));
}

function newHandle(random: Uint8Array): string {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[(random[i] as number) & 31];
  return out;
}

export class FileHandles {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
    private readonly random: () => Uint8Array = () =>
      globalThis.crypto.getRandomValues(new Uint8Array(LENGTH)),
  ) {}

  /** The handle of a path, made if there is none yet. */
  async forPath(connectionId: number, path: string): Promise<string> {
    const existing = await dbGet<{ handle: string }>(
      this.database,
      sql`SELECT handle FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path}`,
    );
    if (existing) return existing.handle;
    // A collision of 80 random bits is not expected; the unique index would refuse it, and the next try has other bits.
    for (let attempt = 0; attempt < 5; attempt++) {
      const handle = newHandle(this.random());
      try {
        await dbRun(
          this.database,
          sql`INSERT INTO ${table(this.database)} (connection_id, path, handle, created_at) VALUES (${connectionId}, ${path}, ${handle}, ${this.now()})`,
        );
        return handle;
      } catch (error) {
        // Another request made this path's handle meanwhile: that one is the handle.
        const raced = await dbGet<{ handle: string }>(
          this.database,
          sql`SELECT handle FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path}`,
        );
        if (raced) return raced.handle;
        if (attempt === 4) throw error;
      }
    }
    throw new Error('a handle could not be made');
  }

  /**
   * The handles of many paths at once, made for those that have none: one read, and one insert for the missing, so that drawing a folder's listing is two
   * statements and not one for each file. A path another request made a handle for meanwhile has that one.
   */
  async forPaths(connectionId: number, paths: string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const unique = [...new Set(paths)];
    // A statement can bind only so many values.
    const CHUNK = 200;
    const read = async (batch: string[]) => {
      if (batch.length === 0) return;
      const rows = await dbAll<{ path: string; handle: string }>(
        this.database,
        sql`SELECT path, handle FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path IN (${sql.join(
          batch.map((path) => sql`${path}`),
          sql`, `,
        )})`,
      );
      for (const row of rows) found.set(row.path, row.handle);
    };
    for (let i = 0; i < unique.length; i += CHUNK) await read(unique.slice(i, i + CHUNK));
    const missing = unique.filter((path) => !found.has(path));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const batch = missing.slice(i, i + CHUNK);
      const values = batch.map(
        (path) => sql`(${connectionId}, ${path}, ${newHandle(this.random())}, ${this.now()})`,
      );
      // The unique indexes refuse a clash (of a path made meanwhile, or, not expected of 80 random bits, a handle); what is refused is read back below.
      await dbRun(
        this.database,
        sql`INSERT INTO ${table(this.database)} (connection_id, path, handle, created_at) VALUES ${sql.join(values, sql`, `)} ON CONFLICT DO NOTHING`,
      );
      await read(batch);
    }
    // A path still without one lost a clash of handles: that one is made alone, with the retries `forPath` has.
    for (const path of unique)
      if (!found.has(path)) found.set(path, await this.forPath(connectionId, path));
    return found;
  }

  /** Where a handle points, or nothing if there is no such handle. Whether anything is there is for the repository to say. */
  async resolve(handle: string): Promise<{ connectionId: number; path: string } | undefined> {
    if (!isHandle(handle)) return undefined;
    const row = await dbGet<{ connectionId: number | string; path: string }>(
      this.database,
      sql`SELECT connection_id AS "connectionId", path FROM ${table(this.database)} WHERE handle = ${handle}`,
    );
    return row ? { connectionId: Number(row.connectionId), path: row.path } : undefined;
  }

  /**
   * A file or a folder was renamed or moved by Fjord: the handle of `from` is now of `to`, and so are those of everything inside it. A path with
   * no handle has nothing to carry. The handle of a path that `to` already had (it was not there, or Fjord would not have moved over it) is dropped.
   */
  async move(connectionId: number, from: string, to: string): Promise<void> {
    if (from === to) return;
    const inside = `${from.replace(/[\\%_]/g, '\\$&')}/%`;
    const rows = await this.rowsUnder(connectionId, from, inside);
    for (const row of rows) {
      const target = row.path === from ? to : `${to}${row.path.slice(from.length)}`;
      await dbRun(
        this.database,
        sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${target}`,
      );
      await dbRun(
        this.database,
        sql`UPDATE ${table(this.database)} SET path = ${target} WHERE id = ${row.id}`,
      );
    }
  }

  private async rowsUnder(
    connectionId: number,
    path: string,
    inside: string,
  ): Promise<{ id: number; path: string }[]> {
    const rows = await dbAll<{ id: number | string; path: string }>(
      this.database,
      sql`SELECT id, path FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND (path = ${path} OR path LIKE ${inside} ESCAPE '\\')`,
    );
    return rows.map((row) => ({ id: Number(row.id), path: row.path }));
  }
}
