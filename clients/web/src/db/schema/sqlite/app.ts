import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { epochMs, id64, ref64 } from "./columns";

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
    /** The vault (its directory) that opens first, when the account has chosen one; null until then (DESIGN.md §7). */
    defaultVault: text("default_vault"),
  },
  (table) => [
    uniqueIndex("connection_account_repository_idx").on(table.accountId, table.provider, table.owner, table.name),
  ],
);

/**
 * Where `/` lands for an account: the connection it has chosen as its default (DESIGN.md §7). One
 * row per account, and none until it has connected something. The first connection becomes the
 * default; with no row, or a row whose connection is gone, the first one it has is (`src/connections`).
 * `account_id` is better-auth's user id, in the other store, so it is not a foreign key.
 */
export const accountDefault = sqliteTable("account_default", {
  accountId: text("account_id").primaryKey(),
  connectionId: ref64("connection_id").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

/**
 * A repository's tree as the git host listed it, for one commit (DESIGN.md §8, §14). A commit's tree never
 * changes, so this is never stale: a new head is a new row, and a push simply makes the next view read the
 * new commit. `listing` is the JSON of the host's answer (`complete`, and each entry's path, kind, id and
 * size). Only the latest few commits of a connection are kept, and a disconnected repository's go with it.
 */
export const treeCache = sqliteTable(
  "tree_cache",
  {
    connectionId: ref64("connection_id").notNull(),
    commitId: text("commit_id").notNull(),
    listing: text("listing").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [uniqueIndex("tree_cache_connection_commit_idx").on(table.connectionId, table.commitId)],
);
