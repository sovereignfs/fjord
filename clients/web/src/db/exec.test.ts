import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "./client";
import { dbAll, dbGet, dbRun } from "./exec";
import { freshDatabase, testTarget } from "./test-support";

const { leg } = testTarget();
let database: Database;

beforeAll(async () => {
  ({ database } = await freshDatabase());
  // A table of our own: these tests are about the helpers, not about the app's tables.
  // PostgreSQL puts it in `public`, which the reset leaves alone, so drop it first as
  // well as after: a run that failed halfway must not break the next.
  await dbRun(database, sql`DROP TABLE IF EXISTS exec_probe`);
  await dbRun(database, sql`CREATE TABLE exec_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL, big BIGINT NOT NULL)`);
});
afterAll(async () => {
  await dbRun(database, sql`DROP TABLE IF EXISTS exec_probe`);
  await database.close();
});

describe(`portable queries (${leg})`, () => {
  it("returns undefined, and does not throw, when a query matches no row", async () => {
    // drizzle-orm's libSQL `.get()` throws on this; `dbGet` must not.
    expect(await dbGet(database, sql`SELECT * FROM exec_probe WHERE id = 12345`)).toBeUndefined();
  });

  it("runs a statement, then reads the row and the rows back", async () => {
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (1, 'one', 1), (2, 'two', 2)`);
    expect(await dbGet(database, sql`SELECT id, label FROM exec_probe WHERE id = 2`)).toMatchObject({ id: 2, label: "two" });
    const rows = await dbAll<{ id: number }>(database, sql`SELECT id FROM exec_probe ORDER BY id`);
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);
  });

  it("returns a 64-bit integer as a number", async () => {
    const epochMs = 1_800_000_000_123; // past 2^32, well inside 2^53
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (3, 'big', ${epochMs})`);
    const row = await dbGet<{ big: unknown }>(database, sql`SELECT big FROM exec_probe WHERE id = 3`);
    expect(row?.big).toBe(epochMs);
    expect(typeof row?.big).toBe("number");
  });

  it("returns an empty list for no rows", async () => {
    expect(await dbAll(database, sql`SELECT * FROM exec_probe WHERE id < 0`)).toEqual([]);
  });

  it("binds values and does not interpolate them", async () => {
    const label = "a'; DROP TABLE exec_probe; --";
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (4, ${label}, 4)`);
    expect(await dbGet<{ label: string }>(database, sql`SELECT label FROM exec_probe WHERE id = 4`)).toMatchObject({ label });
    expect(await dbGet(database, sql`SELECT id FROM exec_probe WHERE id = 1`)).toBeDefined();
  });

  it("supports ON CONFLICT … DO UPDATE the same way", async () => {
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (5, 'first', 5) ON CONFLICT (id) DO UPDATE SET label = excluded.label`);
    await dbRun(database, sql`INSERT INTO exec_probe (id, label, big) VALUES (5, 'second', 5) ON CONFLICT (id) DO UPDATE SET label = excluded.label`);
    expect(await dbGet<{ label: string }>(database, sql`SELECT label FROM exec_probe WHERE id = 5`)).toMatchObject({ label: "second" });
  });
});

describe(`a 64-bit integer too large for a number (${leg})`, () => {
  it.runIf(leg === "postgres")("is an error, not a rounded value", async () => {
    // Drizzle wraps what a type parser throws; the cause is ours.
    const error = await dbGet(database, sql`SELECT 9007199254740993::bigint AS big`).catch((e: unknown) => e);
    expect((error as Error).cause).toBeInstanceOf(RangeError);
    expect(((error as Error).cause as Error).message).toMatch(/cannot represent/);
  });
});
