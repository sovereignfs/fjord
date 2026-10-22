import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { dbAll } from "./exec";
import * as postgresSchema from "./schema/postgres";
import * as sqliteSchema from "./schema/sqlite";

/**
 * Notices from the worker to the web processes (DESIGN.md §14): the worker appends,
 * each web process remembers the last id it saw and reads what came after. There is
 * no LISTEN/NOTIFY, which SQLite lacks, so this behaves the same on both dialects
 * and with any number of replicas. A reader that has missed some (a restart) simply
 * reads from its last id, and a reader that has never read starts from
 * `latestEventId`.
 *
 * Written as portable SQL through `exec.ts`; the table is interpolated as the
 * dialect's own table object, so it renders as `"event"` or `"fjord"."event"`.
 */
export interface AppEvent {
  id: number;
  kind: string;
  subject: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.event : sqliteSchema.event);

/** Append an event; `now` is for tests. */
export async function appendEvent(
  database: Database,
  event: { kind: string; subject: string },
  now: number = Date.now(),
): Promise<AppEvent> {
  const rows = await dbAll<AppEvent>(
    database,
    sql`INSERT INTO ${table(database)} (kind, subject, created_at)
        VALUES (${event.kind}, ${event.subject}, ${now})
        RETURNING id, kind, subject, created_at AS "createdAt"`,
  );
  return normalise(rows[0] as AppEvent);
}

/** Up to `limit` events with an id greater than `afterId`, oldest first. */
export async function eventsAfter(database: Database, afterId: number, limit = 100): Promise<AppEvent[]> {
  const rows = await dbAll<AppEvent>(
    database,
    sql`SELECT id, kind, subject, created_at AS "createdAt"
        FROM ${table(database)}
        WHERE id > ${afterId}
        ORDER BY id ASC
        LIMIT ${limit}`,
  );
  return rows.map(normalise);
}

/** The highest id so far, or 0 when there are no events. */
export async function latestEventId(database: Database): Promise<number> {
  const rows = await dbAll<{ id: number | null }>(
    database,
    sql`SELECT MAX(id) AS id FROM ${table(database)}`,
  );
  return Number(rows[0]?.id ?? 0);
}

/** Delete events older than `olderThanMs` and say how many went. The worker calls this. */
export async function pruneEvents(database: Database, olderThanMs: number): Promise<number> {
  const rows = await dbAll<{ id: number }>(
    database,
    sql`DELETE FROM ${table(database)} WHERE created_at < ${olderThanMs} RETURNING id`,
  );
  return rows.length;
}

// libSQL rows carry both positional and named keys; hand back a plain object.
function normalise(row: AppEvent): AppEvent {
  return { id: Number(row.id), kind: String(row.kind), subject: String(row.subject), createdAt: Number(row.createdAt) };
}
