import { bigint } from "drizzle-orm/pg-core";

/**
 * The same column vocabulary as `schema/sqlite/columns.ts`; see there. PostgreSQL
 * returns `bigint` as a string unless it is told a mode, so every 64-bit column
 * declares `mode: "number"` (and the client parses `int8` the same way for raw SQL).
 */
export const id64 = (name: string) => bigint(name, { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();

export const epochMs = (name: string) => bigint(name, { mode: "number" });
