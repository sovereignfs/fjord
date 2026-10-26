import { index, pgSchema, text, uniqueIndex } from "drizzle-orm/pg-core";
import { APP_STORE } from "../../config";
import { epochMs, id64, ref64 } from "./columns";

/** The app's schema; better-auth's is `fjord_auth` (DESIGN.md §14). */
export const app = pgSchema(APP_STORE);

/** Notices from the worker to the web processes; see `schema/sqlite/app.ts`. */
export const event = app.table(
  "event",
  {
    id: id64("id"),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [index("event_created_at_idx").on(table.createdAt)],
);

/** A secret the instance holds, envelope encrypted; see `schema/sqlite/app.ts`. */
export const credential = app.table(
  "credential",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(),
    kekId: text("kek_id").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: epochMs("created_at").notNull(),
    rewrappedAt: epochMs("rewrapped_at"),
  },
  (table) => [index("credential_kek_id_idx").on(table.kekId)],
);

/** A repository an account has connected; see `schema/sqlite/app.ts`. */
export const connection = app.table(
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

/** Where `/` lands for an account; see `schema/sqlite/app.ts`. */
export const accountDefault = app.table("account_default", {
  accountId: text("account_id").primaryKey(),
  connectionId: ref64("connection_id").notNull(),
  updatedAt: epochMs("updated_at").notNull(),
});

/** A repository's tree for one commit; see `schema/sqlite/app.ts`. */
export const treeCache = app.table(
  "tree_cache",
  {
    connectionId: ref64("connection_id").notNull(),
    commitId: text("commit_id").notNull(),
    listing: text("listing").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [uniqueIndex("tree_cache_connection_commit_idx").on(table.connectionId, table.commitId)],
);
