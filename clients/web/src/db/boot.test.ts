import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase, getStores } from "./boot";
import type { Database } from "./client";
import { dbAll, dbGet } from "./exec";
import { envFor, resetStores, testTarget } from "./test-support";

const { leg, config } = testTarget();
const KEY = Symbol.for("fjord.database");
const holder = globalThis as { [KEY]?: Promise<{ close(): Promise<void> }> };

afterEach(async () => {
  const booted = holder[KEY];
  delete holder[KEY];
  await (await booted?.catch(() => undefined))?.close();
});

/** The names of the tables a store holds, for any dialect. */
async function tablesOf(database: Database): Promise<string[]> {
  const rows =
    database.dialect === "postgres"
      ? await dbAll<{ name: string }>(
          database,
          sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${database.store === "auth" ? "fjord_auth" : "fjord"}`,
        )
      : await dbAll<{ name: string }>(database, sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`);
  return rows.map((r) => r.name).sort();
}

describe(`booting an instance (${leg})`, () => {
  it("from an empty database: provisions, migrates both stores, and is ready to use", async () => {
    await resetStores(config);
    const { app, auth } = await getStores(envFor(config));
    expect(await dbGet(app, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
    expect(await dbGet(auth, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
  });

  // The two must be separate databases: better-auth owns its tables and the app owns its
  // own, and neither may see or collide with the other's. For sqld this is the
  // `x-namespace` header, which sqld releases before 0.24.33 silently ignore, leaving every
  // namespace the one default database; for a file, two files; for PostgreSQL, two schemas.
  it("keeps the app's tables and better-auth's in separate stores", async () => {
    await resetStores(config);
    const { app, auth } = await getStores(envFor(config));
    expect(await tablesOf(app)).toEqual(["connection", "credential", "event"]);
    const authTables = await tablesOf(auth);
    expect(authTables).toEqual(expect.arrayContaining(["user", "session", "account", "verification", "two_factor", "passkey", "rate_limit"]));
    expect(authTables).not.toContain("event");
  });

  it("is booted once: later callers get the same database", async () => {
    await resetStores(config);
    const first = await getDatabase(envFor(config));
    expect(await getDatabase(envFor(config))).toBe(first);
  });

  it("starts from an already-migrated database without changing it", async () => {
    await resetStores(config);
    const first = await getStores(envFor(config));
    await first.close();
    delete holder[KEY];
    const again = await getStores(envFor(config));
    expect(await dbGet(again.app, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
    expect(await tablesOf(again.auth)).toContain("user");
  });

  it("fails on a bad setting, and tries again on the next call", async () => {
    await expect(getStores({ DB_DIALECT: "mysql" })).rejects.toThrow(/DB_DIALECT/);
    await resetStores(config);
    await expect(getStores(envFor(config))).resolves.toBeDefined();
  });
});
