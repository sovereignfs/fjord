import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { ROLES, type Role } from "../access/policy";
import { waitAfter } from "./password";
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
  /** Whether it has a password (ROADMAP 1c.5). Never the hash: that is in `LinkWithSecret`, for the one place that checks it. */
  hasPassword: boolean;
}

/** What opening a link needs and a list must not show: the password's hash, and where the tries at it stand. */
export interface LinkWithSecret extends LinkRecord {
  passwordHash: string | null;
  failures: number;
  lockedUntil: number | null;
}

/** The most links one document has, revoked or not: a list the owner reads. */
export const MAX_LINKS_PER_DOCUMENT = 50;

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.shareLink : sqliteSchema.shareLink);
const PUBLIC_COLUMNS =
  'id, connection_id AS "connectionId", doc_id AS "docId", role, expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt", CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS "hasPassword"';
const COLUMNS = sql.raw(PUBLIC_COLUMNS);
const SECRET_COLUMNS = sql.raw(`${PUBLIC_COLUMNS}, password_hash AS "passwordHash", failures, locked_until AS "lockedUntil"`);

interface Row {
  id: number | string;
  connectionId: number | string;
  docId: string;
  role: string;
  expiresAt: number | string | null;
  revokedAt: number | string | null;
  createdAt: number | string;
  hasPassword: number | string | boolean;
}
interface SecretRow extends Row {
  passwordHash: string | null;
  failures: number | string;
  lockedUntil: number | string | null;
}

const toRecord = (row: Row): LinkRecord => ({
  id: Number(row.id),
  connectionId: Number(row.connectionId),
  docId: row.docId,
  role: ROLES.includes(row.role as Role) ? (row.role as Role) : "view",
  expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
  revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  createdAt: Number(row.createdAt),
  hasPassword: Number(row.hasPassword) === 1 || row.hasPassword === true,
});

const toSecret = (row: SecretRow): LinkWithSecret => ({ ...toRecord(row), passwordHash: row.passwordHash ?? null, failures: Number(row.failures), lockedUntil: row.lockedUntil === null ? null : Number(row.lockedUntil) });

export class LinkService {
  constructor(
    private readonly database: Database,
    private readonly options: { now?: () => number; random?: (size: number) => Buffer } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Make a link. The token is in the answer and nowhere else: it cannot be read back. `too_many` once a document has the most. */
  async create(connectionId: number, docId: string, role: Role, expiresAt: number | null, createdBy: string, passwordHash: string | null = null): Promise<{ ok: true; id: number; token: string } | { ok: false; reason: "too_many" }> {
    if ((await this.count(connectionId, docId)) >= MAX_LINKS_PER_DOCUMENT) return { ok: false, reason: "too_many" };
    const token = newToken(this.options.random);
    const made = await dbAll<{ id: number | string }>(
      this.database,
      sql`INSERT INTO ${table(this.database)} (connection_id, doc_id, token_hash, role, expires_at, password_hash, created_by, created_at)
          VALUES (${connectionId}, ${docId}, ${hashToken(token)}, ${role}, ${expiresAt}, ${passwordHash}, ${createdBy}, ${this.now()})
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

  /**
   * Change a link that has not been revoked (ROADMAP 1c.7): its role, its expiry (`null` for none; a later one revives an expired
   * link), its password (a hash, or `null` to take it away). A new password forgets the wrong tries at the old one; and because the
   * proof in a cookie is bound to the password's hash, every cookie given for the old one stops working. What is left out is left as it
   * is. False if the document has no such link, or it was revoked: a revoked link stays revoked.
   */
  async update(connectionId: number, docId: string, id: number, change: { role?: Role; expiresAt?: number | null; passwordHash?: string | null }): Promise<boolean> {
    const sets = [] as ReturnType<typeof sql>[];
    if (change.role !== undefined) sets.push(sql`role = ${change.role}`);
    if (change.expiresAt !== undefined) sets.push(sql`expires_at = ${change.expiresAt}`);
    if (change.passwordHash !== undefined) sets.push(sql`password_hash = ${change.passwordHash}`, sql`failures = 0`, sql`locked_until = NULL`);
    if (sets.length === 0) return (await this.list(connectionId, docId)).some((link) => link.id === id && link.revokedAt === null);
    const done = await dbAll<{ id: number }>(
      this.database,
      sql`UPDATE ${table(this.database)} SET ${sql.join(sets, sql`, `)}
          WHERE connection_id = ${connectionId} AND doc_id = ${docId} AND id = ${id} AND revoked_at IS NULL
          RETURNING id`,
    );
    return done.length > 0;
  }

  /** The link a token opens, whether or not it is still good (the policy says that); undefined for a token that opens nothing. */
  async byToken(token: string): Promise<LinkWithSecret | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const row = await dbGet<SecretRow>(this.database, sql`SELECT ${SECRET_COLUMNS} FROM ${table(this.database)} WHERE token_hash = ${hashToken(token)}`);
    return row ? toSecret(row) : undefined;
  }

  /**
   * Take the one try at a link's password that may be made now (ROADMAP 1c.5), or say when the next may be. Every try waits for the
   * last (`waitAfter` its failures), and **the taking is a single statement that only one of several at once can win**, so the
   * tries cannot be made in parallel to get round the wait.
   */
  async claimTry(id: number): Promise<{ claimed: true } | { claimed: false; retryAt: number }> {
    const now = this.now();
    const state = await dbGet<{ failures: number | string }>(this.database, sql`SELECT failures FROM ${table(this.database)} WHERE id = ${id}`);
    if (!state) return { claimed: false, retryAt: now };
    const won = await dbAll<{ id: number }>(
      this.database,
      sql`UPDATE ${table(this.database)} SET locked_until = ${now + waitAfter(Number(state.failures))}
          WHERE id = ${id} AND (locked_until IS NULL OR locked_until <= ${now}) RETURNING id`,
    );
    if (won.length > 0) return { claimed: true };
    const lock = await dbGet<{ lockedUntil: number | string | null }>(this.database, sql`SELECT locked_until AS "lockedUntil" FROM ${table(this.database)} WHERE id = ${id}`);
    return { claimed: false, retryAt: lock?.lockedUntil == null ? now : Number(lock.lockedUntil) };
  }

  /** A wrong password: one more failure, and the next try waits as long as that many failures ask. */
  async recordFailure(id: number): Promise<void> {
    const rows = await dbAll<{ failures: number | string }>(this.database, sql`UPDATE ${table(this.database)} SET failures = failures + 1 WHERE id = ${id} RETURNING failures`);
    const failures = Number(rows[0]?.failures ?? 0);
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET locked_until = ${this.now() + waitAfter(failures)} WHERE id = ${id}`);
  }

  /** The right password: the failures and the wait are forgotten. */
  async recordSuccess(id: number): Promise<void> {
    await dbRun(this.database, sql`UPDATE ${table(this.database)} SET failures = 0, locked_until = NULL WHERE id = ${id}`);
  }

  /** Every link of a connection goes with it (it is disconnected). */
  async forget(connectionId: number): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE connection_id = ${connectionId}`);
  }
}
