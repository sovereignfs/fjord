import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, openDatabase } from "./client";
import { APP_STORE, AUTH_STORE, type DatabaseConfig, type Env, resolveDatabaseConfig } from "./config";
import { provisionStores } from "./provision";
import { createSqldClient, provisionNamespace } from "./sqld";

/**
 * What the data-layer tests run against, and a way to start each from nothing.
 *
 * CI runs the whole suite three times (sqld, a `file:` database, PostgreSQL) by
 * setting the FJORD_TEST_* variables below. They are deliberately **not** the
 * variables the app reads: these tests drop whole schemas and namespaces, and a
 * developer with a real instance's DB_DIALECT and POSTGRES_DB_URL exported in a shell
 * must never find them wiped. With none of them set the tests use a throwaway SQLite
 * file, so `pnpm test` needs no database service.
 *
 *   FJORD_TEST_DB_DIALECT, FJORD_TEST_SQLITE_URL,
 *   FJORD_TEST_SQLD_ADMIN_URL, FJORD_TEST_POSTGRES_DB_URL
 */
export type Leg = "sqld" | "file" | "postgres";

export interface TestTarget {
  leg: Leg;
  config: DatabaseConfig;
}

let target: TestTarget | undefined;

export function testTarget(env: Env = process.env): TestTarget {
  if (target) return target;
  const configured = Boolean(env.FJORD_TEST_DB_DIALECT || env.FJORD_TEST_SQLITE_URL || env.FJORD_TEST_POSTGRES_DB_URL);
  const config = resolveDatabaseConfig(
    configured
      ? {
          DB_DIALECT: env.FJORD_TEST_DB_DIALECT,
          SQLITE_URL: env.FJORD_TEST_SQLITE_URL,
          SQLD_ADMIN_URL: env.FJORD_TEST_SQLD_ADMIN_URL,
          POSTGRES_DB_URL: env.FJORD_TEST_POSTGRES_DB_URL,
        }
      : { DB_DIALECT: "sqlite", SQLITE_URL: `file:${join(mkdtempSync(join(tmpdir(), "fjord-test-")), "fjord.db")}` },
  );
  target = { leg: config.dialect === "postgres" ? "postgres" : config.form, config };
  return target;
}

/** Remove everything the app and auth stores hold, so the next test starts from empty. */
export async function resetStores(config: DatabaseConfig): Promise<void> {
  if (config.dialect === "sqlite" && config.form === "file") {
    for (const path of [config.path, config.authPath]) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
    }
    return;
  }

  if (config.dialect === "sqlite") {
    // Empty each namespace by dropping what is in it. Deleting the namespace through
    // the admin API is not a reset: sqld (v0.24) keeps serving the data of a namespace
    // it reports as destroyed. A namespace has to exist to be emptied, so make it.
    for (const namespace of [APP_STORE, AUTH_STORE]) {
      await provisionNamespace(config.adminUrl, namespace);
      const client = await createSqldClient(config.url, namespace);
      try {
        const objects = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
        for (const row of objects.rows) await client.execute(`DROP TABLE IF EXISTS "${String(row.name)}"`);
      } finally {
        client.close();
      }
    }
    return;
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: config.url });
  await client.connect();
  try {
    // `drizzle` and `drizzle_auth` are where Drizzle keeps its record of applied migrations.
    for (const schema of [APP_STORE, AUTH_STORE, "drizzle", "drizzle_auth"]) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** An empty, provisioned database, opened but not migrated. */
export async function freshDatabase(store: "app" | "auth" = "app"): Promise<{ database: Database } & TestTarget> {
  const { config, leg } = testTarget();
  await resetStores(config);
  await provisionStores(config, 15_000);
  return { database: await openDatabase(config, store), config, leg };
}

/** The environment that makes `resolveDatabaseConfig` return this target's configuration. */
export function envFor(config: DatabaseConfig): Env {
  if (config.dialect === "postgres") return { DB_DIALECT: "postgres", POSTGRES_DB_URL: config.url };
  if (config.form === "file") return { DB_DIALECT: "sqlite", SQLITE_URL: `file:${config.path}` };
  return { DB_DIALECT: "sqlite", SQLITE_URL: config.url, SQLD_ADMIN_URL: config.adminUrl };
}
