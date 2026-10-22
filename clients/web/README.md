# Fjord Web

The hosted web client for [Fjord](../../README.md): your documents as plain files in
a Git repository you control, edited in the browser, shared and commented on like
Google Docs.

**Status: under construction.** The app builds, but there is nothing to use yet:
the page is a placeholder. The design and the plan are:

- [`DESIGN.md`](DESIGN.md): what Fjord Web is, its architecture, and the decisions
  behind it.
- [`ROADMAP.md`](ROADMAP.md): the phases, the tasks, and how each is known to be done.
- [`CLAUDE.md`](CLAUDE.md): the conventions for whoever builds it, human or model.

The format every Fjord client follows is [`spec/SPEC.md`](../../spec/SPEC.md).

## Developing

Needs Node 24 and [pnpm](https://pnpm.io) 11 (the `packageManager` field in
`package.json` names the exact version). This directory is its own project with its
own lockfile; it is not part of the Rust workspace.

```bash
pnpm install        # dependencies, from pnpm-lock.yaml
pnpm dev            # http://localhost:3000
pnpm typecheck
pnpm test
pnpm build
```

CI runs those, and the browser tests, for a change to this directory, and nothing else runs for it
(`.github/workflows/web-ci.yml`).

### The database

Fjord Web keeps accounts, connections, shares and the like in SQLite (the default,
in production too) or PostgreSQL (`DESIGN.md` §14). It makes its own namespaces,
schemas and tables when it starts, from the variables below.

| Variable | Meaning | Default |
| --- | --- | --- |
| `DB_DIALECT` | `sqlite` or `postgres` | `sqlite` |
| `SQLITE_URL` | `http://host:port` for an [sqld](https://github.com/tursodatabase/libsql) service, or `file:/path/fjord.db` for a plain file | `http://sqld:8080` |
| `SQLD_ADMIN_URL` | sqld's admin API, used to create its namespaces | `http://sqld:8081` |
| `POSTGRES_DB_URL` | `postgres://user:password@host:port/db`, required for `postgres` | |
| `POSTGRES_POOL_MAX`, `PGSSLROOTCERT` | pool size (5), and a CA file for `sslmode=verify-*` | |
| `FJORD_DB_CONNECT_TIMEOUT_MS` | how long to wait for the database to come up | 30000 |

You need no database service to develop: a file works with no Docker.

```bash
SQLITE_URL=file:./data/fjord.db pnpm dev      # a file, no Docker
pnpm db:dev sqld                              # or sqld in Docker; prints the variables to export
pnpm db:dev postgres                          # or PostgreSQL, to try the other dialect
pnpm db:dev stop
```

The file form keeps the auth database beside the app's, as `fjord_auth.db`. The tests
use a throwaway file when nothing says otherwise; CI runs them on sqld, a file and
PostgreSQL. They read `FJORD_TEST_*` variables, not the ones above, because they drop
whole databases (`src/db/test-support.ts`).

### Signing in

Local sign-in (email and password, passkeys, two-factor) is **off unless `FJORD_AUTH_LOCAL` is
set**; then `/sign-in`, `/sign-up` and `/api/auth` answer 404. The server refuses to start on a
setting that is wrong, and says which. Try it:

```bash
export FJORD_AUTH_LOCAL=1 FJORD_URL=http://localhost:3000
export FJORD_AUTH_SECRET="$(openssl rand -base64 48)"   # 32 characters or more
SQLITE_URL=file:./data/fjord.db pnpm dev
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `FJORD_AUTH_LOCAL` | `1` or `true` turns local sign-in on | off |
| `FJORD_URL` | the address people use; https except on localhost. Passkeys and email links are made from it | required |
| `FJORD_AUTH_SECRET` or `_FILE` | signs sessions and tokens, 32 characters or more | required |
| `FJORD_AUTH_SIGNUP` | `closed`: the first account only. `open`: anyone | `closed` |
| `FJORD_AUTH_PASSWORD_MIN_LENGTH` | | 10 |
| `FJORD_NAME` | what an authenticator app and a passkey call the instance | Fjord |
| `FJORD_PASSKEY_RP_ID` | the passkey relying party, to share passkeys across subdomains | the host of `FJORD_URL` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` or `_FILE`, `SMTP_FROM` | email, optional. With it, addresses are verified and a password can be reset by email; without it, neither | none |
| `FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION` | `false` to skip verification even with SMTP | on with SMTP |

Run it **behind a reverse proxy that sets `X-Forwarded-For`**: the sign-in rate limit is per
address, and a client that reaches the app directly can name its own (`DESIGN.md` §15).

Browser tests run the built app in Chromium, with a virtual authenticator for passkeys:

```bash
pnpm exec playwright install chromium   # once, about 100 MB
pnpm build && pnpm e2e
```

**Changing the schema** means changing it twice, because the two dialects use
different builders: `src/db/schema/sqlite/` and `src/db/schema/postgres/`. A parity
test fails if they drift. Then generate the migrations, never write them by hand and
never `drizzle-kit push`:

```bash
pnpm db:generate add_connection     # writes migrations/{sqlite,postgres}/NNNN_add_connection.sql
pnpm boot-check                     # after pnpm build: boots an instance on the database in the environment
```

## Licence

[AGPL-3.0-or-later](LICENSE), because the app bundles `@sovereignfs/ui`
(`DESIGN.md` §18). The rest of the repository is MPL-2.0, and the specification is CC0.
