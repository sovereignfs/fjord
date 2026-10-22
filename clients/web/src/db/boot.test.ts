import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase } from "./boot";
import { dbGet } from "./exec";
import { envFor, resetStores, testTarget } from "./test-support";

const { leg, config } = testTarget();
const KEY = Symbol.for("fjord.database");
const holder = globalThis as { [KEY]?: Promise<{ close(): Promise<void> }> };

afterEach(async () => {
  const booted = holder[KEY];
  delete holder[KEY];
  await (await booted?.catch(() => undefined))?.close();
});

describe(`booting an instance (${leg})`, () => {
  it("from an empty database: provisions, migrates, and is ready to use", async () => {
    await resetStores(config);
    const database = await getDatabase(envFor(config));
    expect(await dbGet(database, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
    const table = database.dialect === "postgres" ? sql`"fjord"."event"` : sql`"event"`;
    expect(await dbGet(database, sql`SELECT COUNT(*) AS n FROM ${table}`)).toMatchObject({ n: expect.anything() });
  });

  it("is booted once: later callers get the same database", async () => {
    await resetStores(config);
    const first = await getDatabase(envFor(config));
    expect(await getDatabase(envFor(config))).toBe(first);
  });

  it("starts from an already-migrated database without changing it", async () => {
    await resetStores(config);
    const first = await getDatabase(envFor(config));
    await first.close();
    delete holder[KEY];
    const again = await getDatabase(envFor(config));
    expect(await dbGet(again, sql`SELECT 1 AS ok`)).toMatchObject({ ok: 1 });
  });

  it("fails on a bad setting, and tries again on the next call", async () => {
    await expect(getDatabase({ DB_DIALECT: "mysql" })).rejects.toThrow(/DB_DIALECT/);
    await resetStores(config);
    await expect(getDatabase(envFor(config))).resolves.toBeDefined();
  });
});
