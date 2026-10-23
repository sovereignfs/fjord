import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { epochMs, id64 } from "./columns";

/**
 * Notices from the worker to the web processes (DESIGN.md §14): an upstream change
 * was detected, an idle version was committed. PostgreSQL has LISTEN/NOTIFY and
 * SQLite does not, so nothing depends on it; the worker appends here and web
 * processes read from the last id they saw, which works on both dialects and with
 * several replicas.
 */
export const event = sqliteTable(
  "event",
  {
    id: id64("id"),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [index("event_created_at_idx").on(table.createdAt)],
);

/**
 * A secret the instance holds for someone: today a git host credential (DESIGN.md §7), never
 * stored as it is. Envelope encrypted (`src/crypto/`): `ciphertext` is the secret under a data
 * key of its own, `wrapped_key` is that data key under the instance key named by `kek_id`. The
 * id is random, not a counter, because the encryption is bound to it before the row exists.
 */
export const credential = sqliteTable(
  "credential",
  {
    id: text("id").primaryKey(),
    /** What it is for, e.g. `github-pat`. Bound into the encryption, so it cannot be moved to another use. */
    purpose: text("purpose").notNull(),
    kekId: text("kek_id").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: epochMs("created_at").notNull(),
    /** When the data key was last wrapped under a newer instance key, if it has been. */
    rewrappedAt: epochMs("rewrapped_at"),
  },
  (table) => [index("credential_kek_id_idx").on(table.kekId)],
);

/**
 * A repository an account has connected (DESIGN.md §7). Which host, and how it is reached
 * (`kind`: a personal access token today, a GitHub App installation later), and the id of the
 * credential in the `credential` table, never the credential. `account_id` is better-auth's
 * user id: that table is in the other store, so it is not a foreign key. `branch` is the one
 * Fjord works on, the default branch when it was connected (DESIGN.md §19 #6).
 */
export const connection = sqliteTable(
  "connection",
  {
    id: id64("id"),
    accountId: text("account_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    branch: text("branch").notNull(),
    credentialId: text("credential_id").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("connection_account_repository_idx").on(table.accountId, table.provider, table.owner, table.name),
  ],
);
