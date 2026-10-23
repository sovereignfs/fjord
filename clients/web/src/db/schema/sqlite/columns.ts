import { integer } from "drizzle-orm/sqlite-core";

/**
 * The column vocabulary every table is written in, so that a kind of value has
 * one representation on both dialects (DESIGN.md §14). `schema/postgres/columns.ts`
 * exports the same names; the schema parity test keeps the two in step.
 *
 * - `id64`     a generated 64-bit key, read back as a JS number.
 * - `epochMs`  a point in time as milliseconds since the epoch, a JS number: no
 *              time zones, no Date parsing, the same on both dialects.
 * - `ref64`    a reference to another table's `id64`.
 */
export const id64 = (name: string) => integer(name, { mode: "number" }).primaryKey({ autoIncrement: true });

export const epochMs = (name: string) => integer(name, { mode: "number" });

/** A reference to another table's `id64`: the same 64-bit integer, read back as a JS number, not a key itself. */
export const ref64 = (name: string) => integer(name, { mode: "number" });
