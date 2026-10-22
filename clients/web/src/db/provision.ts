import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pgConnectionOptions } from "./client";
import { APP_STORE, AUTH_STORE, type DatabaseConfig } from "./config";
import { retryUntil } from "./retry";
import { provisionNamespace } from "./sqld";

/**
 * Make sure the places the two stores live in exist, before anything connects to
 * them: the sqld namespaces, the directory for the SQLite files, the auth schema in
 * PostgreSQL. Idempotent, and it waits for a service that is still starting, up to
 * `timeoutMs`, since the app and its database come up together.
 *
 * The app's own tables are not made here: migrations make them (`migrate.ts`),
 * including PostgreSQL's `fjord` schema. better-auth's tables come with ROADMAP 1a.2;
 * until then its store is empty, but it exists.
 */
export async function provisionStores(config: DatabaseConfig, timeoutMs = 30_000): Promise<void> {
  if (config.dialect === "sqlite" && config.form === "file") {
    await mkdir(dirname(config.path), { recursive: true });
    return;
  }

  if (config.dialect === "sqlite") {
    try {
      await retryUntil(async () => {
        await provisionNamespace(config.adminUrl, APP_STORE);
        await provisionNamespace(config.adminUrl, AUTH_STORE);
      }, timeoutMs);
    } catch (error) {
      throw new Error(`could not reach the sqld admin API at ${config.adminUrl} (set SQLD_ADMIN_URL): ${message(error)}`);
    }
    return;
  }

  const { default: pg } = await import("pg");
  await retryUntil(async () => {
    const client = new pg.Client(pgConnectionOptions(config));
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${AUTH_STORE}"`);
    } finally {
      await client.end();
    }
  }, timeoutMs).catch((error: unknown) => {
    throw new Error(`could not reach PostgreSQL (check POSTGRES_DB_URL): ${message(error)}`);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
