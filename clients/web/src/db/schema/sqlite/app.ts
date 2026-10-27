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
export const workingCopy = sqliteTable(
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
export const deletion = sqliteTable(
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
export const docIndex = sqliteTable(
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
export const shareUser = sqliteTable(
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

/**
 * A link that lets anyone who has it open a document (DESIGN.md §12, ROADMAP 1c.3). A document can have several, each with a
 * role, an optional expiry and a way to be revoked. **The token is never stored**: `token_hash` is the SHA-256 of a random
 * 256-bit token, shown once to the owner who made the link; whoever holds a copy of the database cannot open a link from it.
 * Like a named share, a link is of a connection and a Doc `id`, so it follows the file through a rename or a move. A revoked link
 * is kept (`revoked_at`) so that the owner's list says what happened; it allows nothing. A disconnected repository's links go
 * with it.
 */
export const shareLink = sqliteTable(
  "share_link",
  {
    id: id64("id"),
    connectionId: ref64("connection_id").notNull(),
    /** The Doc's `id`. */
    docId: text("doc_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").notNull(),
    /** When it stops working, if it does. */
    expiresAt: epochMs("expires_at"),
    revokedAt: epochMs("revoked_at"),
    createdBy: text("created_by").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("share_link_token_hash_idx").on(table.tokenHash),
    index("share_link_document_idx").on(table.connectionId, table.docId),
  ],
);
