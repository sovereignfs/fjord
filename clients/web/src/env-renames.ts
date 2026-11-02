import { ConfigError, type Env } from "./db/config";

/**
 * Settings that Fjord Web used to read without its prefix, or under names of its own, and now reads
 * under the names of Sovereign's environment convention (`contracts/env.md` in sovereignfs/sovereign):
 * every variable starts `FJORD_`, and a setting that Sovereign names has Sovereign's name. It is what a
 * Sovereign instance gives a hosted app, and what an operator's `suite.yml` can set (DESIGN.md §17).
 *
 * The old names still work, so an instance set up before the rename keeps starting: each reader maps
 * them onto the new ones here, and the server says at start-up which old names it read. Setting an old
 * name and its new one together is an error, since which should win is not a question to answer for
 * the operator.
 */

/** One-to-one renames: the old name, and the new one. A secret's `_FILE` form is renamed with it. */
const SOVEREIGN: readonly (readonly [string, string])[] = [
  ["FJORD_AUTH_SOVEREIGN_ISSUER", "FJORD_CORE_URL"],
  ["FJORD_AUTH_SOVEREIGN_CLIENT_ID", "FJORD_CORE_CLIENT_ID"],
  ["FJORD_AUTH_SOVEREIGN_CLIENT_SECRET", "FJORD_CORE_CLIENT_SECRET"],
];

const SMTP: readonly (readonly [string, string])[] = [
  ["SMTP_HOST", "FJORD_SMTP_HOST"],
  ["SMTP_PORT", "FJORD_SMTP_PORT"],
  ["SMTP_SECURE", "FJORD_SMTP_SECURE"],
  ["SMTP_USER", "FJORD_SMTP_USER"],
  ["SMTP_PASSWORD", "FJORD_SMTP_PASSWORD"],
  ["SMTP_FROM", "FJORD_SMTP_FROM"],
];

/** The database's old names. They do not map one to one: `SQLITE_URL` named an sqld service or a file. */
const OLD_DATABASE = ["DB_DIALECT", "SQLITE_URL", "SQLD_ADMIN_URL", "POSTGRES_DB_URL", "POSTGRES_POOL_MAX"] as const;
const NEW_DATABASE = [
  "FJORD_DB_DIALECT",
  "FJORD_SQLD_URL",
  "FJORD_SQLD_ADMIN_URL",
  "FJORD_SQLITE_URL",
  "FJORD_POSTGRES_URL",
  "FJORD_POSTGRES_URL_FILE",
  "FJORD_POSTGRES_POOL_MAX",
] as const;

/** The Sovereign sign-in settings under their new names, from the old ones if those are what is set. */
export function sovereignEnv(env: Env): Env {
  return renamed(env, SOVEREIGN);
}

/** The SMTP settings under their new names, from the old ones if those are what is set. */
export function smtpEnv(env: Env): Env {
  return renamed(env, SMTP);
}

/**
 * The database settings under their new names. With the old ones, `DB_DIALECT=sqlite` (or none) is `sqld`
 * when `SQLITE_URL` is an address and `sqlite` when it is a `file:`; `DB_DIALECT=postgres` is `postgres`.
 * New and old names are not mixed: an instance uses one set or the other.
 */
export function databaseEnv(env: Env): Env {
  const old = OLD_DATABASE.filter((name) => isSet(env[name]));
  if (old.length === 0) return env;
  const current = NEW_DATABASE.filter((name) => isSet(env[name]));
  if (current.length > 0) {
    throw new ConfigError(`Set the database with the FJORD_ names or the old ones, not both: ${current.join(", ")} and ${old.join(", ")}.`);
  }

  const dialect = (env.DB_DIALECT ?? "").trim().toLowerCase() || "sqlite";
  const next: Env = { ...env };
  if (dialect === "postgres") {
    next.FJORD_DB_DIALECT = "postgres";
    next.FJORD_POSTGRES_URL = env.POSTGRES_DB_URL;
    next.FJORD_POSTGRES_POOL_MAX = env.POSTGRES_POOL_MAX;
  } else if (dialect === "sqlite") {
    const url = (env.SQLITE_URL ?? "").trim();
    if (url.startsWith("file:")) {
      next.FJORD_DB_DIALECT = "sqlite";
      next.FJORD_SQLITE_URL = url;
    } else {
      next.FJORD_DB_DIALECT = "sqld";
      next.FJORD_SQLD_URL = env.SQLITE_URL;
      next.FJORD_SQLD_ADMIN_URL = env.SQLD_ADMIN_URL;
    }
  } else {
    throw new ConfigError(`DB_DIALECT must be "sqlite" or "postgres" (got "${env.DB_DIALECT?.trim()}"); its new name is FJORD_DB_DIALECT.`);
  }
  return next;
}

/** The old names this environment sets, each with its new name, for the server to say so at start-up. */
export function oldNamesInUse(env: Env): string[] {
  const pairs = [...SOVEREIGN, ...SMTP];
  const renames = pairs.flatMap(([old, current]) => [
    ...(isSet(env[old]) ? [`${old} (now ${current})`] : []),
    ...(isSet(env[`${old}_FILE`]) ? [`${old}_FILE (now ${current}_FILE)`] : []),
  ]);
  const database = OLD_DATABASE.filter((name) => isSet(env[name])).map((name) => `${name} (now ${databaseRename(name)})`);
  return [...database, ...renames];
}

function databaseRename(name: (typeof OLD_DATABASE)[number]): string {
  switch (name) {
    case "DB_DIALECT":
      return "FJORD_DB_DIALECT: sqld, sqlite or postgres";
    case "SQLITE_URL":
      return "FJORD_SQLD_URL for an sqld service, FJORD_SQLITE_URL for a file";
    case "SQLD_ADMIN_URL":
      return "FJORD_SQLD_ADMIN_URL";
    case "POSTGRES_DB_URL":
      return "FJORD_POSTGRES_URL";
    case "POSTGRES_POOL_MAX":
      return "FJORD_POSTGRES_POOL_MAX";
  }
}

function renamed(env: Env, pairs: readonly (readonly [string, string])[]): Env {
  let next: Env | undefined;
  for (const [old, current] of pairs) {
    for (const suffix of ["", "_FILE"]) {
      const from = `${old}${suffix}`;
      if (!isSet(env[from])) continue;
      const clash = [current, `${current}_FILE`].find((name) => isSet(env[name]));
      if (clash) throw new ConfigError(`Set ${clash} or its old name ${from}, not both.`);
      next ??= { ...env };
      next[`${current}${suffix}`] = env[from];
    }
  }
  return next ?? env;
}

/** Empty counts as unset, as it does for every setting (an `.env` line with no value). */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
