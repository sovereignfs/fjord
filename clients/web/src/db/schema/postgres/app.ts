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

/**
 * What was deleted from a repository through this app (DESIGN.md §8, ROADMAP 1b.12): one row per file, so that **Undo**
 * and **Recently deleted** can put the last blob back. Git still has it in its history; this is how the app finds it, and
 * how long it offers it (a restore window). A folder's deletion is its files' rows, with the one deleting commit.
 */
export const deletion = app.table(
  "deletion",
  {
    id: id64("id"),
    connectionId: ref64("connection_id").notNull(),
    /** Where it was, repository-relative with forward slashes. */
    path: text("path").notNull(),
    /** The Doc's `id` (spec §8.3), when it was read: a single document or note with a header. Null otherwise. */
    docId: text("doc_id"),
    /** `note`, `document` or `other`: what its name made it. */
    kind: text("kind").notNull(),
    /** Its last blob: what a restore commits back. */
    blob: text("blob").notNull(),
    /** The commit that deleted it. */
    deletingCommit: text("deleting_commit").notNull(),
    /** The account that did it. */
    deletedBy: text("deleted_by").notNull(),
    deletedAt: epochMs("deleted_at").notNull(),
    /** When it was put back; null while it is not. */
    restoredAt: epochMs("restored_at"),
  },
  (table) => [index("deletion_connection_idx").on(table.connectionId, table.deletedAt)],
);

/**
 * Which Doc is at which path of a repository (DESIGN.md §9, §14, ROADMAP 1b.6), so that `/doc/<id>` and `/note/<id>` can find
 * a file without listing every repository. One row per Markdown file of a plaintext vault that has been **read**: `doc_id`
 * is the `id` of its header (spec §8.3), or null when it has none, which is still worth knowing (the file is not read again
 * until its blob changes). `blob` is the file's git object id when it was read, and the index is trusted only where it still
 * matches the repository's tree: a file that was edited, moved or deleted elsewhere is read again, never believed. An id is
 * unique within a repository (spec E401) but not across them, nor is the index a promise of that, so a lookup may find
 * several. A disconnected repository's rows go with it.
 */
export const docIndex = app.table(
  "doc_index",
  {
    id: id64("id"),
    connectionId: ref64("connection_id").notNull(),
    /** Repository-relative, with forward slashes. */
    path: text("path").notNull(),
    /** The Doc's `id`; null for a file with no header or no valid `id`. */
    docId: text("doc_id"),
    /** `note` or `document`: what its name made it. */
    kind: text("kind").notNull(),
    blob: text("blob").notNull(),
    indexedAt: epochMs("indexed_at").notNull(),
  },
  (table) => [uniqueIndex("doc_index_connection_path_idx").on(table.connectionId, table.path), index("doc_index_doc_id_idx").on(table.docId)],
);

/**
 * A document shared with a named account of the instance (DESIGN.md §12, ROADMAP 1c.2): one row per document and account,
 * with the role it has there (`view`, `comment` or `edit`). A document is its connection and its Doc `id` (spec §8.3), not
 * its path, so a share follows the file when it is renamed or moved. `account_id` is better-auth's user id, in the other store,
 * so it is not a foreign key; `created_by` is the owner who shared it. Only an existing account is ever named, and a
 * disconnected repository's shares go with it.
 */
export const shareUser = app.table(
  "share_user",
  {
    id: id64("id"),
    connectionId: ref64("connection_id").notNull(),
    /** The Doc's `id`. */
    docId: text("doc_id").notNull(),
    accountId: text("account_id").notNull(),
    role: text("role").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("share_user_document_account_idx").on(table.connectionId, table.docId, table.accountId),
    index("share_user_account_idx").on(table.accountId),
  ],
);
