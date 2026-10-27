import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";

/**
 * Drafts of files being edited (DESIGN.md §11, ROADMAP 1b.8): what someone has typed so far, kept as they type so that
 * closing the tab and opening it again finds it. A draft is **not** in the repository; it becomes a version when someone
 * saves one (1b.9). This is the storage and its rules, keyed by connection and path; who may touch which connection is
 * `src/working/access.ts`.
 *
 * The rules that are here because the database makes them so:
 *
 * - **The text must be storable.** PostgreSQL's `text` cannot hold a NUL, and a lone surrogate is not text in UTF-8; both
 *   are refused (a note with a NUL is binary data, and is read, not edited). At most 1 MiB, as a note read.
 * - **A draft is of one version.** It records the blob the file had when the draft was started (`baseBlob`), and a save
 *   for a different base is refused, never merged into the draft: a commit is made only on top of the draft's base
 *   (DESIGN.md §11).
 * - **No editor is lost.** `editors` is who edited since the last version. Saves are compare-and-swap on the time of the
 *   last edit, so two saves at once both leave their editor in the list, without a transaction held across anything.
 */
export const MAX_CONTENT_BYTES = 1024 * 1024;
export const MAX_DRAFTS_PER_CONNECTION = 500;
/** How many times a save retries when another save got in between. */
const ATTEMPTS = 8;

/** Who edited. Tagged so that a person without an account (ROADMAP 1c.6) can be added without a migration. */
export type Editor = { type: "account"; id: string };

export interface WorkingCopy {
  path: string;
  baseBlob: string;
  content: string;
  editors: Editor[];
  createdAt: number;
  lastEdit: number;
}

export type SaveResult =
  | { ok: true; workingCopy: WorkingCopy }
  /** The draft is of a different version of the file. `baseBlob` is the one it is of. */
  | { ok: false; reason: "base_mismatch"; baseBlob: string }
  | { ok: false; reason: "too_many" }
  | { ok: false; reason: "unstorable"; message: string };

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.workingCopy : sqliteSchema.workingCopy);
const COLUMNS = sql.raw('id, path, base_blob AS "baseBlob", content, editors, created_at AS "createdAt", last_edit AS "lastEdit"');

interface Row {
  id: number;
  path: string;
  baseBlob: string;
  content: string;
  editors: string;
  createdAt: number;
  lastEdit: number;
}

const toCopy = (row: Row): WorkingCopy => ({
  path: row.path,
  baseBlob: row.baseBlob,
  content: row.content,
  editors: JSON.parse(row.editors) as Editor[],
  createdAt: Number(row.createdAt),
  lastEdit: Number(row.lastEdit),
});

/** Why a text cannot be kept as a draft, or `undefined` if it can. */
export function whyUnstorable(content: string): string | undefined {
  if (content.includes("\u0000")) return "It contains a NUL character, which this kind of draft cannot hold.";
  if (!content.isWellFormed()) return "It contains a character that is not valid Unicode text.";
  if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) return "It is larger than 1 MB.";
  return undefined;
}

export type RebaseResult =
  | { ok: true; workingCopy: WorkingCopy }
  /** The draft is not as it was looked at: gone, on another base, or typed into since. */
  | { ok: false; reason: "changed" }
  | { ok: false; reason: "unstorable"; message: string };

export class WorkingCopyService {
  private readonly now: () => number;

  constructor(
    private readonly database: Database,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async get(connectionId: number, path: string): Promise<WorkingCopy | undefined> {
    const row = await this.row(connectionId, path);
    return row ? toCopy(row) : undefined;
  }

  /**
   * Keep `content` as the draft of `path`, started from `baseBlob`, edited by `editor`. Creates the draft or replaces its
   * text; adds the editor to those who have edited since the last version.
   */
  async save(connectionId: number, path: string, input: { baseBlob: string; content: string }, editor: Editor): Promise<SaveResult> {
    const unstorable = whyUnstorable(input.content);
    if (unstorable) return { ok: false, reason: "unstorable", message: unstorable };

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const existing = await this.row(connectionId, path);
      const now = this.now();

      if (!existing) {
        if ((await this.count(connectionId)) >= MAX_DRAFTS_PER_CONNECTION) return { ok: false, reason: "too_many" };
        const created = await dbAll<Row>(
          this.database,
          sql`INSERT INTO ${table(this.database)} (connection_id, path, base_blob, content, editors, created_at, last_edit)
              VALUES (${connectionId}, ${path}, ${input.baseBlob}, ${input.content}, ${JSON.stringify([editor])}, ${now}, ${now})
              ON CONFLICT (connection_id, path) DO NOTHING
              RETURNING ${COLUMNS}`,
        );
        if (created[0]) return { ok: true, workingCopy: toCopy(created[0]) };
        continue; // somebody else made it a moment ago: look again
      }

      if (existing.baseBlob !== input.baseBlob) return { ok: false, reason: "base_mismatch", baseBlob: existing.baseBlob };

      const before = toCopy(existing);
      const editors = before.editors.some((candidate) => candidate.type === editor.type && candidate.id === editor.id) ? before.editors : [...before.editors, editor];
      const lastEdit = Math.max(now, before.lastEdit + 1);
      const updated = await dbAll<Row>(
        this.database,
        sql`UPDATE ${table(this.database)}
            SET content = ${input.content}, editors = ${JSON.stringify(editors)}, last_edit = ${lastEdit}
            WHERE id = ${existing.id} AND last_edit = ${existing.lastEdit} AND base_blob = ${input.baseBlob}
            RETURNING ${COLUMNS}`,
      );
      if (updated[0]) return { ok: true, workingCopy: toCopy(updated[0]) };
    }
    throw new Error("a draft could not be saved: it kept changing underneath");
  }

  /** Throw the draft away. False if there was none. */
  async discard(connectionId: number, path: string): Promise<boolean> {
    const rows = await dbAll<{ id: number }>(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path} RETURNING id`);
    return rows.length > 0;
  }

  /**
   * Move the draft onto another version of the file, with this text (ROADMAP 1b.10): the file changed in the repository
   * and the person chose to go on from there. Only if it is still the draft that was looked at (its base and its last edit
   * are as they were), so that nothing typed meanwhile is overwritten; the editor is added to those who have edited.
   */
  async rebase(
    connectionId: number,
    path: string,
    input: { fromBase: string; toBase: string; content: string; lastEdit: number },
    editor: Editor,
  ): Promise<RebaseResult> {
    const unstorable = whyUnstorable(input.content);
    if (unstorable) return { ok: false, reason: "unstorable", message: unstorable };
    const existing = await this.row(connectionId, path);
    if (!existing || existing.baseBlob !== input.fromBase || Number(existing.lastEdit) !== input.lastEdit) return { ok: false, reason: "changed" };
    const before = toCopy(existing);
    const editors = before.editors.some((candidate) => candidate.type === editor.type && candidate.id === editor.id) ? before.editors : [...before.editors, editor];
    const updated = await dbAll<Row>(
      this.database,
      sql`UPDATE ${table(this.database)}
          SET base_blob = ${input.toBase}, content = ${input.content}, editors = ${JSON.stringify(editors)}, last_edit = ${Math.max(this.now(), input.lastEdit + 1)}
          WHERE id = ${existing.id} AND last_edit = ${existing.lastEdit} AND base_blob = ${input.fromBase}
          RETURNING ${COLUMNS}`,
    );
    return updated[0] ? { ok: true, workingCopy: toCopy(updated[0]) } : { ok: false, reason: "changed" };
  }

  /**
   * Throw the draft away only if nothing was saved to it since `lastEdit`: it has just become a version, and a change that
   * arrived while that was being made is not part of it. False if there was no such draft.
   */
  async discardUnchanged(connectionId: number, path: string, lastEdit: number): Promise<boolean> {
    const rows = await dbAll<{ id: number }>(
      this.database,
      sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path} AND last_edit = ${lastEdit} RETURNING id`,
    );
    return rows.length > 0;
  }

  /** Every draft of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }

  /** The path of every draft of a connection (at most `MAX_DRAFTS_PER_CONNECTION`). */
  async paths(connectionId: number): Promise<string[]> {
    const rows = await dbAll<{ path: string }>(this.database, sql`SELECT path FROM ${table(this.database)} WHERE connection_id = ${connectionId} ORDER BY path`);
    return rows.map((row) => row.path);
  }

  async count(connectionId: number): Promise<number> {
    const row = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
    return Number(row?.n ?? 0);
  }

  private async row(connectionId: number, path: string): Promise<Row | undefined> {
    return dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND path = ${path}`);
  }
}
