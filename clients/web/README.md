# Fjord Web

The hosted web client for [Fjord](../../README.md): your documents as plain files in
a Git repository you control, edited in the browser, shared and commented on like
Google Docs.

**Status: young, and in use.** You can sign in, connect a GitHub repository or start one on the server, write
documents, notes, journal entries and a site's posts, encrypt a vault, share with people on your instance, publish a
page, and comment. The design and the plan are:

- [`DESIGN.md`](DESIGN.md): what Fjord Web is, its architecture, and the decisions
  behind it.
- [`ROADMAP.md`](ROADMAP.md): the phases, the tasks, and how each is known to be done.
- [`CLAUDE.md`](CLAUDE.md): the conventions for whoever builds it, human or model.

The format every Fjord client follows is [`docs/specs/Fjord.spec.md`](../../docs/specs/Fjord.spec.md).

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

### Running it

To run an instance (not to develop), build the container image and use one of the three Compose setups in
[`deploy/`](deploy/README.md): sqld (the default), a single container with a database file, or PostgreSQL. It has the
configuration, a reverse proxy, backups and updating.

```bash
cd deploy && cp .env.example .env     # edit it
docker compose up -d --build          # from this checkout
```

Each release also publishes the image, for `linux/amd64` and `linux/arm64`: `ghcr.io/sovereignfs/fjord-web:X.Y.Z`, with
its build provenance attested. Set `FJORD_IMAGE` to it in `.env` and `docker compose pull && docker compose up -d`
instead of building. What an update does to the database, and how to go back, is in
[`deploy/README.md`](deploy/README.md#updating).

### On a Sovereign instance

A [Sovereign](https://github.com/sovereignfs/sovereign) instance can host Fjord Web as one of its apps: `sv app add --image
ghcr.io/sovereignfs/fjord-web:X.Y.Z` reads `sovereign.manifest.json` from the image and registers it, signs people in through the instance,
and gives it a PostgreSQL database and its secrets. Nothing here requires one. [`deploy/README.md`](deploy/README.md#hosted-on-a-sovereign-instance)
has what an operator sets.

### The database

Fjord Web keeps accounts, connections, shares and the like in SQLite (the default,
in production too) or PostgreSQL (`DESIGN.md` §14). It makes its own namespaces,
schemas and tables when it starts, from the variables below.

| Variable | Meaning | Default |
| --- | --- | --- |
| `FJORD_DB_DIALECT` | `sqld`, `sqlite` (a plain file) or `postgres` | `sqld` |
| `FJORD_SQLD_URL` | `http://host:port` of an [sqld](https://github.com/tursodatabase/libsql) service | `http://sqld:8080` |
| `FJORD_SQLD_ADMIN_URL` | sqld's admin API, used to create its namespaces | `http://sqld:8081` |
| `FJORD_SQLITE_URL` | `file:/path/fjord.db`, required for `sqlite` | |
| `FJORD_POSTGRES_URL` or `_FILE` | `postgres://user:password@host:port/db`, required for `postgres` | |
| `FJORD_POSTGRES_POOL_MAX`, `PGSSLROOTCERT` | pool size (5), and a CA file for `sslmode=verify-*` | |
| `FJORD_DB_CONNECT_TIMEOUT_MS` | how long to wait for the database to come up | 30000 |

You need no database service to develop: a file works with no Docker.

```bash
FJORD_DB_DIALECT=sqlite FJORD_SQLITE_URL=file:./data/fjord.db pnpm dev   # a file, no Docker
pnpm db:dev sqld                              # or sqld in Docker; prints the variables to export
pnpm db:dev postgres                          # or PostgreSQL, to try the other dialect
pnpm db:dev stop
```

**Older names.** These variables used to be read as `DB_DIALECT`, `SQLITE_URL`, `SQLD_ADMIN_URL`,
`POSTGRES_DB_URL`, `POSTGRES_POOL_MAX`, `SMTP_*` and `FJORD_AUTH_SOVEREIGN_ISSUER`, `_CLIENT_ID` and
`_CLIENT_SECRET`. Now every one starts `FJORD_`, and a setting that
[Sovereign's convention](https://github.com/sovereignfs/sovereign/blob/main/contracts/env.md) names has its name,
which is what a Sovereign instance gives an app it hosts. The old names still work and the server says at start-up
which it read; an old name with its new one is an error. `DB_DIALECT=sqlite` meant sqld, or a file when `SQLITE_URL`
was a `file:`; the new dialects say which.

The file form keeps the auth database beside the app's, as `fjord_auth.db`. The tests
use a throwaway file when nothing says otherwise; CI runs them on sqld, a file and
PostgreSQL. They read `FJORD_TEST_*` variables, not the ones above, because they drop
whole databases (`src/db/test-support.ts`).

### Signing in

There are two ways to sign in, and each is **off unless it is set**: local (email and password,
passkeys, two-factor) with `FJORD_AUTH_LOCAL`, and Sovereign (OIDC) with
`FJORD_CORE_*`. With neither, `/sign-in`, `/sign-up` and `/api/auth` answer 404. Either
or both can be on. The server refuses to start on a setting that is wrong, and says which. Try
local sign-in:

```bash
export FJORD_AUTH_LOCAL=1 FJORD_URL=http://localhost:3000
export FJORD_AUTH_SECRET="$(openssl rand -base64 48)"   # 32 characters or more
FJORD_DB_DIALECT=sqlite FJORD_SQLITE_URL=file:./data/fjord.db pnpm dev
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `FJORD_AUTH_LOCAL` | `1` or `true` turns local sign-in on | off |
| `FJORD_CORE_URL` | a Sovereign instance's core, which is its OIDC issuer: its address with no path, e.g. `https://sovereign.example.com` (https, except on localhost) | off |
| `FJORD_CORE_CLIENT_ID` | the client registered for this instance (below) | with the core |
| `FJORD_CORE_CLIENT_SECRET` or `_FILE` | its secret. All three are needed together; some without the others is an error | with the core |
| `FJORD_URL` | the address people use; https except on localhost. Passkeys, email links and the Sovereign redirect URI are made from it | required with either |
| `FJORD_AUTH_SECRET` or `_FILE` | signs sessions and tokens, 32 characters or more | required with either |
| `FJORD_AUTH_SIGNUP` | `closed`: the first account only. `open`: anyone. For either way in | `closed` |
| `FJORD_AUTH_PASSWORD_MIN_LENGTH` | | 10 |
| `FJORD_NAME` | what an authenticator app and a passkey call the instance | Fjord |
| `FJORD_PASSKEY_RP_ID` | the passkey relying party, to share passkeys across subdomains | the host of `FJORD_URL` |
| `FJORD_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASSWORD` or `_PASSWORD_FILE`, `_FROM` | email, optional. With it, addresses are verified and a password can be reset by email; without it, neither | none |
| `FJORD_AUTH_REQUIRE_EMAIL_VERIFICATION` | `false` to skip verification even with SMTP | on with SMTP |

**Connecting a repository.** Signed in, open **Repositories**, give the repository's address and a
**fine-grained personal access token**: on GitHub, Settings, Developer settings, Personal access tokens,
Fine-grained tokens, with *Repository access* limited to that one repository and the repository
permission **Contents: Read and write** (Metadata: Read comes with it). To see a site's build on its page
(repository kind `ssg`), also give it **Checks**, **Commit statuses** and **Deployments**, each *Read*; without them the page says
it cannot read the build, and the rest works. Fjord checks that the token
works, and can write, before keeping it, and keeps it encrypted (it needs `FJORD_ENCRYPTION_KEY`,
below; without one the page says so). `FJORD_GITHUB_API_URL` is only for a GitHub Enterprise Server
(`https://github.example.com/api/v3`); tokens are sent there, so it must be https.

**Changing an address.** Under *Account*, *Profile*, with the password. With email the address it has is asked first and the new one after; without it, it changes at once. An address that is Sovereign's to give is changed there.

**Deleting an account.** A person deletes their own under *Account*, *Profile*, with the address typed out and the password where it has one. What is deleted is what a Sovereign notice deletes (`src/sovereign/people.ts`). With `FJORD_AUTH_SIGNUP=closed`, deleting the only account means the next person to sign up is the first account again.

When both ways of signing in are on, an account made with a password can **link** a Sovereign account on
its security page: Sovereign must use the same email address as the account, or nothing is linked. After that
either way signs in the same account. An account that came in through Sovereign has no password; it can
sign in through Sovereign only.

Once a repository is connected, `/` is a page of tiles, one for each; signing in lands on your default repository (`/open`), which is the first one you connect, and **Make this my default** on another one changes it. A rail down the left has an icon for each repository, by its kind, to move between them. A repository opens on one of its vaults: the first that its `fjord.json` lists, until you
choose another with **Open this one first** on the list of vaults.

**Reading repositories needs the format module.** The web client runs the Fjord format as WebAssembly (`fjord-core`
compiled by `crates/fjord-wasm`). Build it once, and again when `fjord-core` changes:

```bash
pnpm build:wasm      # needs Rust, the wasm32-unknown-unknown target and wasm-bindgen: crates/fjord-wasm/README.md
```

It is loaded from `crates/fjord-wasm/pkg/node` next to this app; `FJORD_WASM_DIR` names another directory (a
container image's, say). Without it a repository's page says the instance cannot read repositories yet, and the
tests that need it are skipped (in CI, which builds it, a missing module is a failure).

**The app imports the editors' package, which has to be built first.** `packages/fjord-editor` is a linked dependency
(`link:../../packages/fjord-editor`), so after `pnpm install`, and again when the package changes:

```bash
pnpm build:editor    # installs the package's own dependencies and builds it; before pnpm typecheck, pnpm build and pnpm dev
```

CI and the image do the same before they type-check or build the app.

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

[AGPL-3.0-or-later](LICENSE), chosen when `@sovereignfs/ui` was AGPL (`DESIGN.md` §18; it is
now MPL-2.0, so the licence is the project's choice rather than the design system's requirement). The rest of the repository is MPL-2.0, and the specification is CC0.
