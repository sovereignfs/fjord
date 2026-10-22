import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type Database } from "./client";
import { APP_STORE, AUTH_STORE, resolveDatabaseConfig } from "./config";
import { dbGet } from "./exec";
import { provisionStores } from "./provision";
import { createSqldClient, provisionNamespace } from "./sqld";
import { freshDatabase, resetStores, testTarget } from "./test-support";

const { leg, config } = testTarget();
const open: Database[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
});

describe(`provisioning (${leg})`, () => {
  it("can be repeated", async () => {
    await resetStores(config);
    await provisionStores(config, 15_000);
    await expect(provisionStores(config, 15_000)).resolves.toBeUndefined();
  });

  it("makes the auth store exist", async () => {
    const { database } = await freshDatabase();
    open.push(database);

    if (config.dialect === "postgres") {
      const row = await dbGet<{ n: number | string }>(
        database,
        sql`SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ${AUTH_STORE}`,
      );
      expect(Number(row?.n)).toBe(1);
    } else if (config.form === "sqld") {
      const client = await createSqldClient(config.url, AUTH_STORE);
      const result = await client.execute("SELECT 1 AS one");
      expect(Number(result.rows[0]?.one)).toBe(1);
      client.close();
    } else {
      // A file store needs only its directory; the auth file is created when it is opened.
      expect(config.authPath).toMatch(/fjord_auth\.db$/);
    }
  });
});

describe(`the app and auth stores (${leg})`, () => {
  // The two must be separate databases: better-auth owns its tables and the app owns
  // its own, and neither may see or collide with the other's. With sqld the separation
  // is the `x-namespace` header, which sqld releases before 0.24.33 silently ignore,
  // leaving every namespace the one default database. Nothing else would notice.
  it.runIf(leg === "sqld")("are separate namespaces, not one database", async () => {
    if (config.dialect !== "sqlite" || config.form !== "sqld") return;
    await freshDatabase().then(({ database }) => database.close());
    const app = await createSqldClient(config.url, APP_STORE);
    const auth = await createSqldClient(config.url, AUTH_STORE);
    try {
      await app.execute("CREATE TABLE namespace_probe (x)");
      const seenByAuth = await auth.execute("SELECT name FROM sqlite_master WHERE name = 'namespace_probe'");
      expect(seenByAuth.rows).toHaveLength(0);
    } finally {
      await app.execute("DROP TABLE IF EXISTS namespace_probe");
      app.close();
      auth.close();
    }
  });

  it.runIf(leg === "postgres")("are separate schemas", async () => {
    const { database } = await freshDatabase();
    open.push(database);
    // `fjord_auth` exists, `fjord` is made by the migrations: neither holds the other's tables.
    const row = await dbGet<{ n: number | string }>(
      database,
      sql`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ${AUTH_STORE}`,
    );
    expect(Number(row?.n)).toBe(0);
  });
});

describe(`creating a namespace (${leg})`, () => {
  // A namespace that has never existed, so this is about creating one and not about
  // what a reset left behind. sqld only.
  it.runIf(leg === "sqld")("makes it usable, and is idempotent", async () => {
    if (config.dialect !== "sqlite" || config.form !== "sqld") return;
    const namespace = `fjord_test_${Math.random().toString(36).slice(2, 10)}`;
    await provisionNamespace(config.adminUrl, namespace);
    await provisionNamespace(config.adminUrl, namespace);
    const client = await createSqldClient(config.url, namespace);
    try {
      await client.execute("CREATE TABLE t (a)");
      expect((await client.execute("SELECT COUNT(*) AS n FROM t")).rows[0]?.n).toBe(0);
    } finally {
      client.close();
      await fetch(`${config.adminUrl}/v1/namespaces/${namespace}`, { method: "DELETE" });
    }
  });
});

describe("provisioning a service that is not there", () => {
  it("says which setting to check for sqld", async () => {
    const down = resolveDatabaseConfig({ SQLITE_URL: "http://127.0.0.1:1", SQLD_ADMIN_URL: "http://127.0.0.1:1" });
    await expect(provisionStores(down, 100)).rejects.toThrow(/SQLD_ADMIN_URL/);
  });

  it("says which setting to check for PostgreSQL", async () => {
    const down = resolveDatabaseConfig({ DB_DIALECT: "postgres", POSTGRES_DB_URL: "postgres://u:p@127.0.0.1:1/x" });
    await expect(provisionStores(down, 100)).rejects.toThrow(/POSTGRES_DB_URL/);
  });
});

describe("the SQLite file form", () => {
  it.runIf(leg === "file")("is in WAL mode, so a second process can read while one writes", async () => {
    const { database } = await freshDatabase();
    open.push(database);
    const row = await dbGet<{ journal_mode: string }>(database, sql`PRAGMA journal_mode`);
    expect(row?.journal_mode).toBe("wal");
  });
});
