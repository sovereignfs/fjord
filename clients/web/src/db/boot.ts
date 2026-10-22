import { type Database, openDatabase } from "./client";
import { type Env, describeConfig, resolveDatabaseConfig } from "./config";
import { runMigrations } from "./migrate";
import { provisionStores } from "./provision";

/**
 * Bring the database up: read the configuration, make sure the stores exist, open both,
 * and apply each one's migrations. It runs once at server start (`instrumentation.ts`)
 * and fails loudly, so an instance that cannot reach or migrate its database does not
 * start. Anything that later needs a database asks `getDatabase()` (the app's tables) or
 * `getAuthDatabase()` (better-auth's), which return the ones this opened.
 *
 * Both stores are migrated whatever the sign-in settings: the auth store is part of the
 * database, and the tables of a method that is switched off are simply unused.
 */
export interface Stores {
  app: Database;
  auth: Database;
  close(): Promise<void>;
}

const KEY = Symbol.for("fjord.database");
type Holder = { [KEY]?: Promise<Stores> };

export function getStores(env: Env = process.env): Promise<Stores> {
  // On `globalThis`, because the development server reloads modules and a second
  // copy of this one must not open a second pool.
  const holder = globalThis as Holder;
  holder[KEY] ??= boot(env).catch((error: unknown) => {
    // Forget a failure, so the next call tries again rather than failing forever.
    delete holder[KEY];
    throw error;
  });
  return holder[KEY];
}

export async function getDatabase(env: Env = process.env): Promise<Database> {
  return (await getStores(env)).app;
}

export async function getAuthDatabase(env: Env = process.env): Promise<Database> {
  return (await getStores(env)).auth;
}

async function boot(env: Env): Promise<Stores> {
  const config = resolveDatabaseConfig(env);
  const timeoutMs = Number(env.FJORD_DB_CONNECT_TIMEOUT_MS) || 30_000;
  console.info(`[fjord] database: ${describeConfig(config)}`);
  await provisionStores(config, timeoutMs);

  const app = await openDatabase(config, "app");
  const auth = await openDatabase(config, "auth");
  const close = async () => {
    await Promise.all([app.close(), auth.close()]);
  };
  try {
    await runMigrations(app);
    await runMigrations(auth);
  } catch (error) {
    await close();
    throw error;
  }
  console.info("[fjord] database: ready, migrations applied");
  return { app, auth, close };
}
