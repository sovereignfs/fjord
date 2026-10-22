/**
 * Which database Fjord Web runs on, read from the environment in one place
 * (DESIGN.md §14). Nothing else reads these variables.
 *
 *   DB_DIALECT          sqlite (default) or postgres
 *   SQLITE_URL          http(s)://host:port for an sqld service (default
 *                       http://sqld:8080), or file:/path/fjord.db for a file
 *   SQLD_ADMIN_URL      sqld's admin API, used to create the namespaces
 *                       (default http://sqld:8081)
 *   POSTGRES_DB_URL     postgres://... (required when DB_DIALECT=postgres)
 *   POSTGRES_POOL_MAX   connections in the pool (default 5)
 *   PGSSLROOTCERT       CA file for sslmode=verify-ca / verify-full
 *
 * Nothing infers the dialect from a URL: `DB_DIALECT` says which, and a URL that
 * does not fit it is an error, not a guess.
 */

/** The two logical databases: the app's tables and better-auth's. */
export const APP_STORE = "fjord";
export const AUTH_STORE = "fjord_auth";

const DEFAULT_SQLD_URL = "http://sqld:8080";
const DEFAULT_SQLD_ADMIN_URL = "http://sqld:8081";
const DEFAULT_POOL_MAX = 5;

export type DatabaseConfig = SqldConfig | FileConfig | PostgresConfig;

/** SQLite through an sqld service: one namespace per store. */
export interface SqldConfig {
  dialect: "sqlite";
  form: "sqld";
  url: string;
  adminUrl: string;
}

/** SQLite in a plain file, with the auth store beside it as `fjord_auth.db`. */
export interface FileConfig {
  dialect: "sqlite";
  form: "file";
  /** The app database's file path. */
  path: string;
  /** The auth database's file path, in the same directory. */
  authPath: string;
}

/** PostgreSQL: one schema per store. */
export interface PostgresConfig {
  dialect: "postgres";
  url: string;
  poolMax: number;
  /** Contents of the CA file named by PGSSLROOTCERT, read by the client. */
  sslRootCertPath?: string;
}

/** A setting that is wrong; the message names the variable and what it should be. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** What `process.env` is, and what a test can pass instead. */
export type Env = Record<string, string | undefined>;

export function resolveDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const raw = env.DB_DIALECT?.trim().toLowerCase();
  const dialect = raw === undefined || raw === "" ? "sqlite" : raw;

  if (dialect === "postgres") return resolvePostgres(env);
  if (dialect === "sqlite") return resolveSqlite(env);
  throw new ConfigError(`DB_DIALECT must be "sqlite" or "postgres" (got "${raw}").`);
}

function resolveSqlite(env: Env): SqldConfig | FileConfig {
  const url = (env.SQLITE_URL ?? "").trim() || DEFAULT_SQLD_URL;

  if (url.startsWith("file:")) return resolveFile(url);

  const parsed = parseUrl("SQLITE_URL", url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `SQLITE_URL must be http(s)://host:port for an sqld service or file:/path for a file (got "${parsed.protocol}//…").`,
    );
  }
  const adminUrl = (env.SQLD_ADMIN_URL ?? "").trim() || DEFAULT_SQLD_ADMIN_URL;
  const admin = parseUrl("SQLD_ADMIN_URL", adminUrl);
  if (admin.protocol !== "http:" && admin.protocol !== "https:") {
    throw new ConfigError(`SQLD_ADMIN_URL must be an http(s) URL (got "${admin.protocol}//…").`);
  }
  return { dialect: "sqlite", form: "sqld", url: stripTrailingSlash(url), adminUrl: stripTrailingSlash(adminUrl) };
}

function resolveFile(url: string): FileConfig {
  // `file:/abs/path`, `file:///abs/path` and `file:relative/path` all name a path.
  let path = url.slice("file:".length);
  if (path.startsWith("//")) path = path.slice(2);
  if (path === "" || path === ":memory:" || path.startsWith(":memory:")) {
    throw new ConfigError('SQLITE_URL "file:" needs a path to a database file; an in-memory database is not allowed.');
  }
  if (path.endsWith("/")) {
    throw new ConfigError(`SQLITE_URL "${url}" names a directory; it must name the database file.`);
  }
  const slash = path.lastIndexOf("/");
  const directory = slash === -1 ? "" : path.slice(0, slash + 1);
  return { dialect: "sqlite", form: "file", path, authPath: `${directory}${AUTH_STORE}.db` };
}

function resolvePostgres(env: Env): PostgresConfig {
  const url = (env.POSTGRES_DB_URL ?? "").trim();
  if (url === "") throw new ConfigError("DB_DIALECT=postgres requires POSTGRES_DB_URL.");
  const parsed = parseUrl("POSTGRES_DB_URL", url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigError(`POSTGRES_DB_URL must be a postgres:// URL (got "${parsed.protocol}//…").`);
  }
  const rootCert = (env.PGSSLROOTCERT ?? "").trim();
  return {
    dialect: "postgres",
    url,
    poolMax: poolMax(env.POSTGRES_POOL_MAX),
    ...(rootCert === "" ? {} : { sslRootCertPath: rootCert }),
  };
}

/** A bad or missing value falls back to the default rather than trusting it. */
function poolMax(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX;
}

function parseUrl(variable: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigError(`${variable} is not a valid URL.`);
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** What is safe to print about a configuration: no password, no token. */
export function describeConfig(config: DatabaseConfig): string {
  if (config.dialect === "postgres") {
    const url = new URL(config.url);
    return `postgres ${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  }
  return config.form === "sqld" ? `sqlite via sqld at ${new URL(config.url).origin}` : `sqlite file ${config.path}`;
}
