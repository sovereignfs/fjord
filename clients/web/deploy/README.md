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
- **Each instance registers its own GitHub App** (ROADMAP 1a.6); until that is built, a repository is connected with a
  fine-grained personal access token.

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

## Updating

```bash
git pull
docker compose up -d --build        # with the same -f arguments as before
```

The new version applies its migrations when it starts, before it serves. Migrations only go forward: to go back to an
older version, restore a backup taken before the update.

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
