import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import type { Tree, TreeEntry } from "../providers/types";

/**
 * A repository's tree for a commit, kept so that looking at it again costs no request to the git host
 * (DESIGN.md §8, §14). The key is the commit, and a commit's tree never changes, so a cached tree is never
 * stale: a push makes a new head and the next view reads the new commit. What is kept is the host's own
 * answer, `complete` included (a very large repository's listing comes back cut short), and only the
 * latest few commits of a connection.
 */
export const KEEP_COMMITS = 3;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.treeCache : sqliteSchema.treeCache);

interface Stored {
  complete: boolean;
  entries: TreeEntry[];
}

export class TreeCache {
  constructor(private readonly database: Database) {}

  async get(connectionId: number, commit: string): Promise<Tree | undefined> {
    const row = await dbGet<{ listing: string }>(this.database, sql`SELECT listing FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND commit_id = ${commit}`);
    if (!row) return undefined;
    const stored = JSON.parse(row.listing) as Stored;
    return { commit, entries: stored.entries, complete: stored.complete };
  }

  /** Keep a tree, and drop all but the latest few of the connection's. `now` is for tests. */
  async put(connectionId: number, tree: Tree, now: number = Date.now()): Promise<void> {
    const listing = JSON.stringify({ complete: tree.complete, entries: tree.entries } satisfies Stored);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, commit_id, listing, created_at)
          VALUES (${connectionId}, ${tree.commit}, ${listing}, ${now})
          ON CONFLICT (connection_id, commit_id) DO UPDATE SET listing = ${listing}, created_at = ${now}`,
    );
    const kept = await dbAll<{ commitId: string }>(
      this.database,
      sql`SELECT commit_id AS "commitId" FROM ${table(this.database)} WHERE connection_id = ${connectionId} ORDER BY created_at DESC, commit_id DESC LIMIT ${KEEP_COMMITS}`,
    );
    if (kept.length < KEEP_COMMITS) return;
    const keep = sql.join(kept.map((row) => sql`${row.commitId}`), sql`, `);
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND commit_id NOT IN (${keep})`);
  }

  /** Forget everything of a connection, as when it is disconnected. */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
