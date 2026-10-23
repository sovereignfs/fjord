import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
