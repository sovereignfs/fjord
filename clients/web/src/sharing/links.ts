import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { ROLES, type Role } from "../access/policy";
import { TOKEN_PATTERN, hashToken, newToken } from "./tokens";

/**
 * Links that open a document (DESIGN.md §12, ROADMAP 1c.3): who made which, at what role, until when, and whether it was
 * revoked. The token is shown once, when the link is made, and only its hash is kept (`tokens.ts`); finding a link by the token
 * someone presents is the one way in. Whether a link lets anyone do anything is `access/policy.ts`'s to say, from the role,
 * the expiry and the revocation this returns.
 */
export interface LinkRecord {
  id: number;
  connectionId: number;
  docId: string;
  role: Role;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

/** The most links one document has, revoked or not: a list the owner reads. */
export const MAX_LINKS_PER_DOCUMENT = 50;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);
const COLUMNS = sql.raw('id, connection_id AS "connectionId", doc_id AS "docId", role, expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"');

interface Row {
  id: number | string;
  connectionId: number | string;
  docId: string;
  role: string;
  expiresAt: number | string | null;
  revokedAt: number | string | null;
  createdAt: number | string;
}

const toRecord = (row: Row): LinkRecord => ({
  id: Number(row.id),
  connectionId: Number(row.connectionId),
  docId: row.docId,
  role: ROLES.includes(row.role as Role) ? (row.role as Role) : "view",
  expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
  revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  createdAt: Number(row.createdAt),
});

export class LinkService {
  constructor(
    private readonly database: Database,
    private readonly options: { now?: () => number; random?: (size: number) => Buffer } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Make a link. The token is in the answer and nowhere else: it cannot be read back. `too_many` once a document has the most. */
  async create(connectionId: number, docId: string, role: Role, expiresAt: number | null, createdBy: string): Promise<{ ok: true; id: number; token: string } | { ok: false; reason: "too_many" }> {
    if ((await this.count(connectionId, docId)) >= MAX_LINKS_PER_DOCUMENT) return { ok: false, reason: "too_many" };
    const token = newToken(this.options.random);
    const made = await dbAll<{ id: number | string }>(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, role, expires_at, created_by, created_at)
          VALUES (${connectionId}, ${docId}, ${hashToken(token)}, ${role}, ${expiresAt}, ${createdBy}, ${this.now()})
          RETURNING id`,
    );
    return { ok: true, id: Number(made[0]!.id), token };
  }

  async count(connectionId: number, docId: string): Promise<number> {
    const row = await dbGet<{ n: number | string }>(this.database, sql`SELECT COUNT(*) AS n FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId}`);
    return Number(row?.n ?? 0);
  }

  /** A document's links, newest first. Never a token. */
  async list(connectionId: number, docId: string): Promise<LinkRecord[]> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE connection_id = ${connectionId} AND doc_id = ${docId} ORDER BY created_at DESC, id DESC`);
    return rows.map(toRecord);
  }

  /** End a link. False if the document has no such link, or it was revoked already. */
  async revoke(connectionId: number, docId: string, id: number): Promise<boolean> {
    const done = await dbAll<{ id: number }>(
      this.database,
      sql`UPDATE ${table(this.database)} SET revoked_at = ${this.now()}
          WHERE connection_id = ${connectionId} AND doc_id = ${docId} AND id = ${id} AND revoked_at IS NULL
          RETURNING id`,
    );
    return done.length > 0;
  }

  /** The link a token opens, whether or not it is still good (the policy says that); undefined for a token that opens nothing. */
  async byToken(token: string): Promise<LinkRecord | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const row = await dbGet<Row>(this.database, sql`SELECT ${COLUMNS} FROM ${table(this.database)} WHERE token_hash = ${hashToken(token)}`);
    return row ? toRecord(row) : undefined;
  }

  /** Every link of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
