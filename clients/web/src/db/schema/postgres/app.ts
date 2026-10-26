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

/**
 * A draft of a file someone is editing (DESIGN.md §11, §14): what they have typed so far, kept on the server as they
 * type, so that closing the tab and opening it again, or opening it on another device, finds it. **Nothing here is
 * in the repository**: it is a version only when someone saves one (ROADMAP 1b.9). `base_blob` is the file's blob
 * when the draft was started, the version it is a draft *of*, so a commit can be made only on top of it and a file
 * that has moved on is noticed (never overwritten, DESIGN.md §11). `content` is the whole text (a note, so at most
 * 1 MiB, with no NUL and well-formed Unicode, which PostgreSQL's `text` cannot hold). `editors` is the JSON list of
 * who edited since the last version, tagged so that people without an account can join it (`src/working/`). One
 * draft per file, and a disconnected repository's go with it.
 */
export const workingCopy = app.table(
  "working_copy",
  {
    id: id64("id"),
    connectionId: ref64("connection_id").notNull(),
    /** Repository-relative, with forward slashes. */
    path: text("path").notNull(),
    baseBlob: text("base_blob").notNull(),
    content: text("content").notNull(),
    editors: text("editors").notNull(),
    createdAt: epochMs("created_at").notNull(),
    lastEdit: epochMs("last_edit").notNull(),
  },
  (table) => [uniqueIndex("working_copy_connection_path_idx").on(table.connectionId, table.path)],
);
