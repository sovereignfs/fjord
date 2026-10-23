import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { ConfigError } from "../db/config";
import { dbAll, dbGet, dbRun } from "../db/exec";
import * as postgresSchema from "../db/schema/postgres";
import * as sqliteSchema from "../db/schema/sqlite";
import { CredentialError } from "./errors";
import { open, rewrap, seal } from "./envelope";
import type { Keyring } from "./keyring";

/**
 * The instance's credentials, in the database and never as they are (DESIGN.md §7): the
 * envelope encryption of `envelope.ts`, kept in the `credential` table. What stores a
 * credential (a repository connection) holds the id this returns, and asks for the secret
 * back only where it is used, on the server; it is never sent to the browser or written to
 * a log. Portable SQL through `exec.ts`, the same on both dialects.
 */
export interface Credential {
  id: string;
  purpose: string;
  secret: string;
}

export interface Row {
  id: string;
  purpose: string;
  kekId: string;
  wrappedKey: string;
  ciphertext: string;
}

export interface KeyStatus {
  total: number;
  /** Under the current instance key. */
  current: number;
  /** Under a previous key that is still configured: waiting for a restart to re-wrap them. */
  older: number;
  /** Under a key that is not configured: they cannot be opened. Fingerprint to count. */
  unknown: Record<string, number>;
}

const table = (database: Database) => (database.dialect === "postgres" ? postgresSchema.credential : sqliteSchema.credential);
const columns = sql.raw('id, purpose, kek_id AS "kekId", wrapped_key AS "wrappedKey", ciphertext');

export class CredentialStore {
  constructor(
    private readonly database: Database,
    private readonly keyring: Keyring,
  ) {}

  /** Seal and store a secret; returns the id to keep. `now` is for tests. */
  async put(purpose: string, secret: string, now: number = Date.now()): Promise<string> {
    const id = randomBytes(16).toString("base64url");
    const sealed = seal(this.keyring, { id, purpose }, secret);
    await dbRun(
      this.database,
      sql`INSERT INTO ${table(this.database)} (id, purpose, kek_id, wrapped_key, ciphertext, created_at)
          VALUES (${id}, ${purpose}, ${sealed.kekId}, ${sealed.wrappedKey}, ${sealed.ciphertext}, ${now})`,
    );
    return id;
  }

  /** The secret, for the server to use. `not_found` for an id that is not there. */
  async get(id: string): Promise<Credential> {
    const row = await dbGet<Row>(this.database, sql`SELECT ${columns} FROM ${table(this.database)} WHERE id = ${id}`);
    if (!row) throw new CredentialError("not_found", "There is no stored credential with that id.");
    return { id, purpose: row.purpose, secret: open(this.keyring, { id, purpose: row.purpose }, row) };
  }

  /** Replace the secret under an id, keeping its purpose. */
  async replace(id: string, secret: string, now: number = Date.now()): Promise<void> {
    const row = await dbGet<{ purpose: string }>(this.database, sql`SELECT purpose FROM ${table(this.database)} WHERE id = ${id}`);
    if (!row) throw new CredentialError("not_found", "There is no stored credential with that id.");
    const sealed = seal(this.keyring, { id, purpose: row.purpose }, secret);
    await dbRun(
      this.database,
      sql`UPDATE ${table(this.database)}
          SET kek_id = ${sealed.kekId}, wrapped_key = ${sealed.wrappedKey}, ciphertext = ${sealed.ciphertext}, rewrapped_at = ${now}
          WHERE id = ${id}`,
    );
  }

  async remove(id: string): Promise<void> {
    await dbRun(this.database, sql`DELETE FROM ${table(this.database)} WHERE id = ${id}`);
  }

  /** Which key each stored credential needs. */
  async status(): Promise<KeyStatus> {
    return keyStatus(this.database, this.keyring);
  }

  /**
   * Wrap every credential's data key under the current instance key: what a rotation is. Only
   * the 32-byte key is rewritten, never the credential. Safe to run again, and from several
   * processes at once: each update says which key it is replacing, so a row another process has
   * already done is left alone. A credential under a key that is not configured cannot be
   * re-wrapped and is left as it is (see `status().unknown`).
   */
  async rewrapAll(now: number = Date.now()): Promise<{ rewrapped: number }> {
    const rows = await dbAll<Row>(this.database, sql`SELECT ${columns} FROM ${table(this.database)} WHERE kek_id <> ${this.keyring.current.id}`);
    let rewrapped = 0;
    for (const row of rows) {
      if (!this.keyring.find(row.kekId)) continue;
      const next = rewrap(this.keyring, { id: row.id, purpose: row.purpose }, row);
      const done = await dbAll<{ id: string }>(
        this.database,
        sql`UPDATE ${table(this.database)}
            SET kek_id = ${next.kekId}, wrapped_key = ${next.wrappedKey}, rewrapped_at = ${now}
            WHERE id = ${row.id} AND kek_id = ${row.kekId}
            RETURNING id`,
      );
      rewrapped += done.length;
    }
    return { rewrapped };
  }
}

async function keyStatus(database: Database, keyring: Keyring | undefined): Promise<KeyStatus> {
  const rows = await dbAll<{ kekId: string; n: number | string }>(database, sql`SELECT kek_id AS "kekId", COUNT(*) AS n FROM ${table(database)} GROUP BY kek_id`);
  const status: KeyStatus = { total: 0, current: 0, older: 0, unknown: {} };
  for (const row of rows) {
    const n = Number(row.n);
    status.total += n;
    if (keyring && row.kekId === keyring.current.id) status.current += n;
    else if (keyring?.find(row.kekId)) status.older += n;
    else status.unknown[row.kekId] = n;
  }
  return status;
}

/**
 * What the server does at start-up about stored credentials: refuse to start if some could never
 * be opened (their key is not configured, or there is no key at all, which is a mistake an
 * operator should hear about now and not when someone's repository stops syncing), and wrap
 * everything under the current key, which is all a rotation asks of an operator.
 */
export async function prepareCredentials(database: Database, keyring: Keyring | undefined): Promise<KeyStatus & { rewrapped: number }> {
  const status = await keyStatus(database, keyring);
  const unknown = Object.entries(status.unknown);
  if (unknown.length > 0) {
    const which = unknown.map(([id, n]) => `${n} under key ${id}`).join(", ");
    throw new ConfigError(
      keyring
        ? `Stored credentials cannot be opened: ${which}. Set the key they were sealed under as FJORD_ENCRYPTION_KEY or FJORD_ENCRYPTION_KEY_PREVIOUS.`
        : `Credentials are stored (${which}), so FJORD_ENCRYPTION_KEY (or _FILE) is required.`,
    );
  }
  if (!keyring || status.older === 0) return { ...status, rewrapped: 0 };
  const { rewrapped } = await new CredentialStore(database, keyring).rewrapAll();
  return { ...status, rewrapped };
}
