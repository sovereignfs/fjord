# Running Fjord Web

Fjord Web is one container image and a database. This directory has the three ways of running it that the design
names ([`DESIGN.md`](../DESIGN.md) §17), as Docker Compose files, and what to know to run it for real. Build the image
from the root of the repository (the Compose files do it for you):

```bash
docker build -f clients/web/Dockerfile -t fjord-web .
```

It builds the format module from `crates/` (Rust and WebAssembly), then the app (Node 24), and keeps neither toolchain:
the image is a Node runtime, the app, the module and the licences, about 100 MB. It runs as an unprivileged user,
listens on port 3000, writes only to `/data` (and only when the database is a file), and has a health check on
`/api/health`.

## Pick a setup

| | Files | The database | Use it when |
| --- | --- | --- | --- |
| **sqld** (default) | `compose.yaml` | [sqld](https://github.com/tursodatabase/libsql), a SQLite server, in its own container | You want the default. |
| **File** | `compose.file.yaml` | A SQLite file on a volume, in the one container | One person or a small group, and the fewest moving parts. Cannot scale out: two instances cannot share a file. |
| **PostgreSQL** | `compose.yaml` + `compose.postgres.yaml` | PostgreSQL in its own container | You already run PostgreSQL, or want to. |

To use a PostgreSQL server you already have, skip the overlay and set `DB_DIALECT=postgres` and `POSTGRES_DB_URL` in
`.env`; with the sqld file, also remove the `sqld` service and the web service's `depends_on`.

```bash
cd clients/web/deploy
cp .env.example .env            # then edit it (below)

docker compose up -d --build                                          # sqld
docker compose -f compose.file.yaml up -d --build                     # a file
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build # PostgreSQL
```

The overlay needs Docker Compose 2.24 or later. The app is on `127.0.0.1:3000` (`FJORD_PORT` changes the host's port);
put a reverse proxy with TLS in front of it ([below](#a-reverse-proxy-with-tls)). The server makes its own namespaces,
schemas and tables when it starts, and applies its migrations; there is no setup step.

## Configuration

Everything is an environment variable, put in `.env` next to the Compose files (which is kept out of version control).
[`.env.example`](.env.example) has the ones a deployment needs; [`../README.md`](../README.md) has every variable.

- **`FJORD_URL`** is the address people use, `https` except on localhost. Passkeys, emailed links and the Sovereign
  redirect address are made from it, so it has to be right.
- **`FJORD_AUTH_SECRET`** (32 characters or more) signs sessions. Changing it signs everyone out.
- **`FJORD_ENCRYPTION_KEY`** encrypts the repository tokens at rest. Without it nobody can connect a repository.
  Keep it with your secrets and **apart from the database backups**: a backup that holds both the tokens and the key
  that opens them is a plaintext copy of the tokens. A lost key means connecting the repositories again.
  Rotating it is `FJORD_ENCRYPTION_KEY_PREVIOUS` for as long as anything is still under the old one (the log says when).
- **`FJORD_RESTORE_WINDOW_DAYS`** (optional, 1 to 3650, default 30) is how long a deleted file is offered for putting back
  under Recently deleted. The file is in the repository's history for good; this is how long the app lists it.
- **`FJORD_IDLE_VERSION_MINUTES`** (optional, 1 to 1440, default 5; `0` turns it off) is how long a draft goes without an edit
  before the app saves it to the repository as a version. **`FJORD_WORKER=off`** keeps a process from doing it: with several
  web processes on one database, set it on all but one.
- A secret can come from a file instead (`FJORD_AUTH_SECRET_FILE`, `FJORD_ENCRYPTION_KEY_FILE`, ...), which is how
  Docker or Kubernetes secrets are passed.
- **Each instance registers its own GitHub App** (ROADMAP 1a.6), which is how people connect repositories without handling a
  token. Without one, a repository is connected with a fine-grained personal access token, and that stays available beside it.
  See [Registering the GitHub App](#registering-the-github-app).

The server **refuses to start on a setting that is wrong** and says which: the container exits, and
`docker compose logs web` ends with `[fjord] cannot start: …`. It does not start and then fail every request.

`GET /api/health` answers `{"status":"ok","database":{…},"format":"ok"}`. `format` is whether the format module loaded;
`"unavailable"` means the image was built or modified wrongly, and repositories cannot be read.

### The database services

- **sqld** is not published to the host: it has no sign-in of its own, and the app reaches it on the Compose network and
  nothing else does. Keep it that way. Its image is pinned to a version that honours the namespace header the app
  relies on (0.24.33 or later; `src/db/provision.test.ts` checks isolation).
- **PostgreSQL** needs `POSTGRES_PASSWORD` in `.env`. It is not published either. For a server elsewhere, use
  `POSTGRES_DB_URL` with `sslmode=verify-full` and `PGSSLROOTCERT` (see the main README).

## A reverse proxy with TLS

The container speaks plain HTTP on one port. Terminate TLS in front of it, forward to `127.0.0.1:3000`, and set
`FJORD_URL` to the public `https` address. The proxy must **set** `X-Forwarded-For` (not pass along what the client
sent), because sign-in rate limits are per client address. For example, with [Caddy](https://caddyserver.com):

```
fjord.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy gets a certificate for the name by itself, and sets `X-Forwarded-For` as asked. (This snippet is an example; it is
not run by the checks below.)

**Keep share-link tokens out of the proxy's access log.** A share link is opened at `/doc/<id>?token=<token>`; the app swaps the
token for a cookie and redirects at once and never logs it, but a reverse proxy logs the address it was asked for, query string
included. Log the path without the query (Caddy's `log` can drop it with a `delete` filter on `uri`'s query; nginx's `$uri` is the path
alone, where `$request` and `$request_uri` are not), or treat that log as holding secrets.

## Backups

What is in the database is accounts, connections, shares and working copies. The documents themselves are in the Git
repositories, which are their own backup. Back up the database *and* keep the encryption key separately (above).

Each of these was run, and the instance signed in again after restoring.

**File.** The volume holds two SQLite databases (`fjord.db`, `fjord_auth.db`) and their write-ahead logs. The simplest
consistent copy is of the volume with the app stopped:

```bash
docker compose -f compose.file.yaml stop web
docker run --rm -v fjord_fjord-data:/data -v "$PWD":/backup alpine tar czf /backup/fjord-data.tgz -C /data .
docker compose -f compose.file.yaml start web
```

To restore, bring the instance down with its volume (`down -v`), create the volume again, extract into it, and bring it
up (`tar` keeps the archive's ownership, which is the image's `node` user):

```bash
docker volume create fjord_fjord-data
docker run --rm -v fjord_fjord-data:/data -v "$PWD":/backup alpine tar xzf /backup/fjord-data.tgz -C /data
docker compose -f compose.file.yaml up -d
```

To back up while it runs, use SQLite's own online backup on each database, for example
`sqlite3 /data/fjord.db ".backup /backup/fjord.db"`, from a container that has `sqlite3` and the volume mounted;
or replicate continuously with [Litestream](https://litestream.io).

**sqld.** The same, for sqld's volume (`fjord_sqld-data`, mounted at `/var/lib/sqld`), with **both** `web` and `sqld`
stopped (`docker compose stop web sqld`), and restored the same way. A snapshot of the volume from the host or the
cloud provider works as well.

**PostgreSQL.** Dump and restore with PostgreSQL's own tools. Stop `web` before restoring, so nothing writes while the
dump goes back in:

```bash
P="-f compose.yaml -f compose.postgres.yaml"
docker compose $P exec -T postgres pg_dump -U fjord --clean --if-exists fjord > fjord.sql
docker compose $P stop web
docker compose $P exec -T postgres psql -q -U fjord fjord < fjord.sql
docker compose $P start web
```

or whatever your usual PostgreSQL backup process is, if the server is yours.

## Registering the GitHub App

On GitHub: Settings, Developer settings, GitHub Apps, **New GitHub App** (for an organisation, the same under its settings). The
App is private to your instance, so nothing of it is shared with anyone else's.

| Setting | Value |
| --- | --- |
| Homepage URL | your `FJORD_URL` |
| **Callback URL** | `<FJORD_URL>/api/github-app/callback` |
| **Request user authorization (OAuth) during installation** | **on**. This is how Fjord learns which of an installation's repositories the person can reach themselves; without it nobody can connect |
| Setup URL | `<FJORD_URL>/api/github-app/callback`, and **Redirect on update** on, so that adding repositories later connects them |
| Webhook | active, URL `<FJORD_URL>/api/webhooks/github`, with a secret of your own (16 characters or more) |
| Repository permissions | **Contents: Read and write**, and Metadata: Read-only (always on). Nothing else |
| Subscribe to events | **Push** |
| Where can it be installed | Any account, if others than you are to use the instance; otherwise Only on this account |

Then, from the App's page: note the **App ID**, the **name** in its address (`github.com/apps/<name>`) and the **Client ID**, make a
**client secret**, and **generate a private key** (a `.pem` file). Set, all of them or none (the server refuses to start on some):

- **`FJORD_GITHUB_APP_ID`**, **`FJORD_GITHUB_APP_SLUG`**, **`FJORD_GITHUB_APP_CLIENT_ID`**.
- **`FJORD_GITHUB_APP_CLIENT_SECRET`**, **`FJORD_GITHUB_APP_WEBHOOK_SECRET`** and **`FJORD_GITHUB_APP_PRIVATE_KEY`** (the PEM, with its
  line breaks, or written with `\n`). Each can be a `_FILE` instead, which is how Docker or Kubernetes secrets are passed.

The webhook must be reachable from the internet; GitHub's *Recent Deliveries* on the App's page shows whether it answers. An instance
that is only on a private network works without it (every page asks GitHub for the head anyway); the webhook only saves work.

With an Enterprise Server, set `FJORD_GITHUB_API_URL` to its API (`https://host/api/v3`); the sign-in and install pages are on the same host.

**What people do:** on *Repositories*, **Install on GitHub**, choose the repositories on GitHub, and come back to find them connected.
Doing it again adds the ones chosen since. Fjord keeps no token: it keeps which installation a repository came through, and asks GitHub
for a token that lasts an hour when it needs one. Removing the App on GitHub ends access at once.

## Updating

Each release publishes the image for `linux/amd64` and `linux/arm64`, with its build provenance attested:

```bash
docker pull ghcr.io/sovereignfs/fjord-web:0.1.0
gh attestation verify oci://ghcr.io/sovereignfs/fjord-web:0.1.0 --owner sovereignfs    # optional
```

The tags are `X.Y.Z` (never moves), `X.Y` (the newest patch of that minor) and `latest`. **Pin one in production**: `latest`
is what a restart at the wrong moment would upgrade you to. Set `FJORD_IMAGE=ghcr.io/sovereignfs/fjord-web:0.1.0` in `.env`
and the compose files use it instead of building (building from a checkout, as above, still works and is what you do for
a version that is not released).

Before updating:

1. **Read the changelog** between your version and the new one ([`CHANGELOG.md`](../CHANGELOG.md), or the release page).
   Anything marked **breaking** is a setting or a behaviour you must act on; a migration is listed under *Changed* or
   *Added*.
2. **Back up the database** ([above](#backups)). Keep the encryption key where it is, apart from the backup.

Then:

```bash
# in .env: FJORD_IMAGE=ghcr.io/sovereignfs/fjord-web:0.2.0
docker compose pull                  # with the same -f arguments as before
docker compose up -d                 # the web service is recreated; sqld or PostgreSQL is left running
curl -fsS http://127.0.0.1:3000/api/health      # {"status":"ok", ...}
```

(If you build from a checkout instead: `git pull`, then `docker compose up -d --build`.)

What happens when the new version starts:

- **It applies its migrations before it serves anything.** Several instances starting together are safe (PostgreSQL takes
  an advisory lock; SQLite fails cleanly and retries). If a migration cannot be applied the server exits, naming the
  migration, and does not serve a half-migrated database.
- **Run one version at a time.** Migrations may remove or change what the old version reads. Stop the old instances
  before starting the new ones, or accept a short outage; do not run old and new side by side on one database.
- **A patch release (`0.1.0` to `0.1.1`) never has a migration**, so you can move between patch releases of a minor in either
  direction without touching the database.
- **A minor release may.** Migrations only go forward. To go back to an older minor, stop the new version, **restore the
  backup taken before the update**, and start the old image; whatever was written since the backup is lost. There is no
  down-migration, on purpose.
- **Nothing else needs upgrading.** The format module (WebAssembly) and the editors are inside the image. A repository
  whose `fjord.json` declares a newer format version than the image implements is opened read-only and never written to; the
  page says so.

To see which version is running, `docker image inspect ghcr.io/sovereignfs/fjord-web:0.2.0 --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'`
(the page and `/api/health` deliberately say nothing about it).

## What is not here yet

- **The worker as a process of its own.** The design runs the image as `web` and as `worker` (idle commits, webhooks), and the
  single-container setup runs both in one process. Idle versions (ROADMAP 1b.13) run inside the web process; a `worker` command
  of this same image, and a Compose service for it, come with the GitHub App's webhooks (1a.6).
- **Continuous backups and a staging instance** are the operator's to set up; this directory does not provide them.

## Checked by CI

[`../scripts/deploy-check.sh`](../scripts/deploy-check.sh) builds nothing itself. Given the image, it brings each of the
three setups up from nothing and checks, for each, that Compose reports it healthy; that `/api/health` names the
right database and says the format module loaded; that the first account can be made; that after the containers are
taken down (keeping their volumes) and up again the account can sign in; and, once, that an image given sign-in
without a secret exits and names it. CI runs it on every change to Fjord Web (`web-ci.yml`, job `image`).

```bash
docker build -f clients/web/Dockerfile -t fjord-web:ci .
FJORD_IMAGE=fjord-web:ci clients/web/scripts/deploy-check.sh          # all three, or name some: sqld file postgres
```

## Licences

The image carries its licences under `/usr/share/licenses/`: Fjord Web's (AGPL-3.0-or-later) and the design system's,
with its `NOTICE`, which holds the licence of the icons derived from Lucide (ISC) and asks that it travel with
copies. Fjord Web is AGPL-3.0-or-later: if you run a modified version for others, they are entitled to its source.
