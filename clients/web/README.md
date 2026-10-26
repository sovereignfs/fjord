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

There are two ways to sign in, and each is **off unless it is set**: local (email and password,
passkeys, two-factor) with `FJORD_AUTH_LOCAL`, and Sovereign (OIDC) with
`FJORD_AUTH_SOVEREIGN_*`. With neither, `/sign-in`, `/sign-up` and `/api/auth` answer 404. Either
or both can be on. The server refuses to start on a setting that is wrong, and says which. Try
local sign-in:

```bash
export FJORD_AUTH_LOCAL=1 FJORD_URL=http://localhost:3000
export FJORD_AUTH_SECRET="$(openssl rand -base64 48)"   # 32 characters or more
SQLITE_URL=file:./data/fjord.db pnpm dev
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `FJORD_AUTH_LOCAL` | `1` or `true` turns local sign-in on | off |
| `FJORD_AUTH_SOVEREIGN_ISSUER` | a Sovereign instance's OIDC issuer, e.g. `https://auth.sovereign.example.com/api/auth` (https, except on localhost) | off |
| `FJORD_AUTH_SOVEREIGN_CLIENT_ID` | the client registered for this instance (below) | with the issuer |
| `FJORD_AUTH_SOVEREIGN_CLIENT_SECRET` or `_FILE` | its secret. All three are needed together; some without the others is an error | with the issuer |
| `FJORD_URL` | the address people use; https except on localhost. Passkeys, email links and the Sovereign redirect URI are made from it | required with either |
| `FJORD_AUTH_SECRET` or `_FILE` | signs sessions and tokens, 32 characters or more | required with either |
| `FJORD_AUTH_SIGNUP` | `closed`: the first account only. `open`: anyone. For either way in | `closed` |
| `FJORD_AUTH_PASSWORD_MIN_LENGTH` | | 10 |
| `FJORD_NAME` | what an authenticator app and a passkey call the instance | Fjord |
| `FJORD_PASSKEY_RP_ID` | the passkey relying party, to share passkeys across subdomains | the host of `FJORD_URL` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` or `_FILE`, `SMTP_FROM` | email, optional. With it, addresses are verified and a password can be reset by email; without it, neither | none |
| `FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION` | `false` to skip verification even with SMTP | on with SMTP |

**Connecting a repository.** Signed in, open **Repositories**, give the repository's address and a
**fine-grained personal access token**: on GitHub, Settings, Developer settings, Personal access tokens,
Fine-grained tokens, with *Repository access* limited to that one repository and the repository
permission **Contents: Read and write** (Metadata: Read comes with it). Fjord checks that the token
works, and can write, before keeping it, and keeps it encrypted (it needs `FJORD_ENCRYPTION_KEY`,
below; without one the page says so). `FJORD_GITHUB_API_URL` is only for a GitHub Enterprise Server
(`https://github.example.com/api/v3`); tokens are sent there, so it must be https.

When both ways of signing in are on, an account made with a password can **link** a Sovereign account on
its security page: Sovereign must use the same email address as the account, or nothing is linked. After that
either way signs in the same account. An account that came in through Sovereign has no password; it can
sign in through Sovereign only.

Once a repository is connected, `/` is that repository: the first one you connect is your default,
and **Make this my default** on another one changes it. With several, a list on the repository's page
moves between them. A repository opens on one of its vaults: the first that its `fjord.json` lists, until you
choose another with **Open this one first** on the list of vaults.

**Reading repositories needs the format module.** The web client runs the Fjord format as WebAssembly (`fjord-core`
compiled by `crates/fjord-wasm`). Build it once, and again when `fjord-core` changes:

```bash
pnpm build:wasm      # needs Rust, the wasm32-unknown-unknown target and wasm-bindgen: crates/fjord-wasm/README.md
```

It is loaded from `crates/fjord-wasm/pkg/node` next to this app; `FJORD_WASM_DIR` names another directory (a
container image's, say). Without it a repository's page says the instance cannot read repositories yet, and the
tests that need it are skipped (in CI, which builds it, a missing module is a failure).

**Credentials at rest.** Repository credentials (a token, a GitHub App's key) are stored
encrypted, under an instance key you provide. Make one and keep it with your secrets, not with
database backups:

```bash
export FJORD_ENCRYPTION_KEY="$(openssl rand -base64 32)"   # or FJORD_ENCRYPTION_KEY_FILE
```

It is optional until the first repository is connected. To **rotate** it, set the new key as
`FJORD_ENCRYPTION_KEY` and the old one as `FJORD_ENCRYPTION_KEY_PREVIOUS` (several, separated by
commas or newlines, if there have been more), then restart. The server wraps every credential
under the new key as it starts, and logs that the previous key can be removed. A server will not
start if stored credentials need a key that is not set: the message names it by fingerprint.
If a key is lost the credentials it protected are lost; connect the repositories again.

**Signing in with Sovereign.** An admin of the Sovereign instance registers Fjord Web in its
Console, under *External clients*: a display name, the redirect URI
`<FJORD_URL>/api/auth/callback/sovereign` (matched exactly, so `http://localhost:3000/...` for
development and the `https://` address for production, each registered), and the scopes `openid
profile email`. The Console shows the client id and secret once; they go in the three variables
above, the secret preferably in a file (`_FILE`). Fjord Web asks for `sub`, `email` and `name`,
uses `sub` to know who someone is, and never signs them out of Sovereign. A Sovereign account is
who someone is, not what they may do here: with `FJORD_AUTH_SIGNUP=closed` only the first account
is made, whichever way it signs in. Put the settings of a development instance in
`clients/web/.env.local`, which is not committed.

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
