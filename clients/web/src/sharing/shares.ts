import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { ROLES, type Role } from "../access/policy";

/**
 * Documents shared with named accounts (DESIGN.md §12, ROADMAP 1c.2): who has which role on which document. A document is its
 * connection and its Doc `id`, so a share follows the file through a rename or a move. This is only the record: whether a
 * share lets anyone do anything is `access/policy.ts`'s to say, and whether an address names an account is the caller's to
 * find out (`auth/users.ts`), so that nothing here can tell anyone which addresses have one.
 */
export interface UserShare {
  accountId: string;
  role: Role;
  createdAt: number;
}

export interface SharedWithAccount {
  connectionId: number;
  docId: string;
  role: Role;
}

/** The most accounts one document is shared with: a share list is something a person reads. */
export const MAX_SHARES_PER_DOCUMENT = 100;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareUser : sqliteSchema.shareUser);

const asRole = (value: string): Role => (ROLES.includes(value as Role) ? (value as Role) : "view");

export class ShareService {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Share a document with an account at a role, or change the role it already has. `too_many` once a document has the most:
   * changing the role of one already there is always allowed.
   */
  async set(connectionId: number, docId: string, accountId: string, role: Role, createdBy: string): Promise<"ok" | "too_many"> {
    const there = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    const already = await dbGet<{ id: number }>(this.database, sql`SELECT id FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId} AND account_id = ${accountId}`);
    if (!already && Number(there?.n ?? 0) >= MAX_SHARES_PER_DOCUMENT) return "too_many";
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, account_id, role, created_by, created_at)
          VALUES (${connectionId}, ${docId}, ${accountId}, ${role}, ${createdBy}, ${this.now()})
          ON CONFLICT (connection_id, doc_id, account_id) DO UPDATE SET role = ${role}`,
    );
    return "ok";
  }

  /** How many accounts a document is shared with. */
  async count(connectionId: number, docId: string): Promise<number> {
    const row = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return Number(row?.n ?? 0);
  }

  /** Who a document is shared with, oldest first. */
  async list(connectionId: number, docId: string): Promise<UserShare[]> {
    const rows = await dbAll<{ accountId: string; role: string; createdAt: number | string }>(
      this.database,
      sql`SELECT account_id AS "accountId", role, created_at AS "createdAt" FROM ${table(this.database)}
          WHERE connection_id = ${connectionId} AND doc_id = ${docId} ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => ({ accountId: row.accountId, role: asRole(row.role), createdAt: Number(row.createdAt) }));
  }

  /** Stop sharing a document with an account. False if it was not shared with it. */
  async remove(connectionId: number, docId: string, accountId: string): Promise<boolean> {
    const gone = await dbAll<{ id: number }>(
      this.database,
      sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId} AND account_id = ${accountId} RETURNING id`,
    );
    return gone.length > 0;
  }

  /** The shares an account holds on a document, across connections (an id is unique within a repository, not across them). */
  async find(accountId: string, docId: string): Promise<{ connectionId: number; role: Role; sharedBy: string }[]> {
    const rows = await dbAll<{ connectionId: number | string; role: string; sharedBy: string }>(
      this.database,
      sql`SELECT connection_id AS "connectionId", role, created_by AS "sharedBy" FROM ${table(this.database)} WHERE account_id = ${accountId} AND doc_id = ${docId} ORDER BY connection_id ASC`,
    );
    return rows.map((row) => ({ connectionId: Number(row.connectionId), role: asRole(row.role), sharedBy: row.sharedBy }));
  }

  /** Everything shared with an account, newest first. */
  async forAccount(accountId: string): Promise<SharedWithAccount[]> {
    const rows = await dbAll<{ connectionId: number | string; docId: string; role: string }>(
      this.database,
      sql`SELECT connection_id AS "connectionId", doc_id AS "docId", role FROM ${table(this.database)} WHERE account_id = ${accountId} ORDER BY created_at DESC, id DESC`,
    );
    return rows.map((row) => ({ connectionId: Number(row.connectionId), docId: row.docId, role: asRole(row.role) }));
  }

  /** Every share of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
