import { readFileSync } from "node:fs";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { APP_STORE, type DatabaseConfig, type FileConfig, type PostgresConfig, type SqldConfig } from "./config";
import * as postgresSchema from "./schema/postgres";
import * as sqliteSchema from "./schema/sqlite";
import { createSqldClient } from "./sqld";

/**
 * A database handle, tagged with its dialect so the portable helpers (`exec.ts`)
 * know how to run a query on it. SQLite is one dialect in two forms: an sqld
 * service and a plain file, both through libSQL.
 */
export type Database = SqliteDatabase | PostgresDatabase;

export interface SqliteDatabase {
  dialect: "sqlite";
  form: "sqld" | "file";
  db: LibSQLDatabase<typeof sqliteSchema>;
  close(): Promise<void>;
}

export interface PostgresDatabase {
  dialect: "postgres";
  db: NodePgDatabase<typeof postgresSchema> & { $client: Pool };
  close(): Promise<void>;
}

/**
 * Open the app's database. Every driver is loaded when it is needed and not before:
 * an sqld or PostgreSQL instance never loads libSQL's native addon, which has no
 * build for every platform (a musl image has none) and would fail at import time.
 */
export async function openDatabase(config: DatabaseConfig): Promise<Database> {
  if (config.dialect === "postgres") return openPostgres(config);
  return config.form === "sqld" ? openSqld(config) : openFile(config);
}

async function openSqld(config: SqldConfig): Promise<SqliteDatabase> {
  const { drizzle } = await import("drizzle-orm/libsql/web");
  const client = await createSqldClient(config.url, APP_STORE);
  return {
    dialect: "sqlite",
    form: "sqld",
    db: drizzle(client, { schema: sqliteSchema }),
    close: async () => client.close(),
  };
}

async function openFile(config: FileConfig): Promise<SqliteDatabase> {
  const { createClient } = await import("@libsql/client/node");
  const { drizzle } = await import("drizzle-orm/libsql/node");
  const client = createClient({ url: `file:${config.path}` });
  // Several processes (web and worker) may share the file on one host: WAL lets
  // readers and a writer overlap, and a busy timeout makes a second writer wait for
  // the first instead of failing. Foreign keys are off in SQLite until asked.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA foreign_keys = ON");
  return {
    dialect: "sqlite",
    form: "file",
    db: drizzle(client, { schema: sqliteSchema }),
    close: async () => client.close(),
  };
}

async function openPostgres(config: PostgresConfig): Promise<PostgresDatabase> {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  // `bigint` comes back as a string by default, which is how a 64-bit integer stays
  // exact. Ours are ids and epoch milliseconds, far below 2^53, and the app wants
  // numbers on both dialects, in raw SQL as in the query builder. It is set on pg's
  // own registry, not on the pool: Drizzle gives each query its own parsers, and
  // falls back to that registry for the types it does not handle itself, so a pool
  // option is silently ignored. A value too large to be exact is an error, not a
  // rounded number.
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError(`a bigint column holds ${value}, which a number cannot represent exactly`);
    return number;
  });
  const pool = new pg.Pool({ ...pgConnectionOptions(config), max: config.poolMax });
  return {
    dialect: "postgres",
    db: drizzle(pool, { schema: postgresSchema }),
    close: async () => pool.end(),
  };
}

/** The connection string and TLS settings, shared by the pool and by provisioning. */
export function pgConnectionOptions(config: PostgresConfig): { connectionString: string; ssl: ReturnType<typeof pgSsl> } {
  return { connectionString: config.url, ssl: pgSsl(config) };
}

/**
 * TLS from the URL's `sslmode`: absent or `disable` is none; `verify-ca` and
 * `verify-full` verify the server's certificate (the CA from PGSSLROOTCERT);
 * anything else encrypts without verifying.
 */
function pgSsl(config: PostgresConfig): false | { rejectUnauthorized: boolean; ca?: string } {
  const sslmode = new URL(config.url).searchParams.get("sslmode");
  if (!sslmode || sslmode === "disable") return false;
  const verify = sslmode === "verify-ca" || sslmode === "verify-full";
  const ca = config.sslRootCertPath ? readFileSync(config.sslRootCertPath, "utf8") : undefined;
  return { rejectUnauthorized: verify, ...(ca ? { ca } : {}) };
}
