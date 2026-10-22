import { type Database, openDatabase } from "./client";
import { type Env, describeConfig, resolveDatabaseConfig } from "./config";
import { runMigrations } from "./migrate";
import { provisionStores } from "./provision";

/**
 * Bring the database up: read the configuration, make sure the stores exist, open
 * the app's database and apply the migrations. It runs once at server start
 * (`instrumentation.ts`) and fails loudly, so an instance that cannot reach or
 * migrate its database does not start. Anything that later needs the database asks
 * `getDatabase()`, which returns the same one.
 */
const KEY = Symbol.for("fjord.database");
type Holder = { [KEY]?: Promise<Database> };

export function getDatabase(env: Env = process.env): Promise<Database> {
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

async function boot(env: Env): Promise<Database> {
  const config = resolveDatabaseConfig(env);
  const timeoutMs = Number(env.FJORD_DB_CONNECT_TIMEOUT_MS) || 30_000;
  console.info(`[fjord] database: ${describeConfig(config)}`);
  await provisionStores(config, timeoutMs);
  const database = await openDatabase(config);
  try {
    await runMigrations(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  console.info("[fjord] database: ready, migrations applied");
  return database;
}
