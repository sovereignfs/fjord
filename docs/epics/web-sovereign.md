# Fjord Web — Hosted on Sovereign

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right.

**Status:** planned on 2026-11-02; H1 and H2 done.

## What this promises, and what it does not

- **A Sovereign instance can host Fjord Web as it hosts any app:** `sv app add fjord --image ghcr.io/sovereignfs/fjord-web:X.Y.Z`, then `sv push && sv deploy`. The instance gives the app its address, a PostgreSQL database, a client at its core and its secrets, under the names of its `contracts/env.md` ([sovereignfs/sovereign](https://github.com/sovereignfs/sovereign)); the app declares what it needs in a manifest, `clients/web/sovereign.manifest.json`, which the image carries as a label.
- **Fjord Web keeps its own existence.** It still runs on its own (`deploy/`), on any of its three databases, with local sign-in, Sovereign sign-in or both. Nothing in it is specific to being hosted beyond reading the names an instance gives. Its links to Sovereign are `@sovereignfs/ui`, the SDK (H3), and sign-in through core, which it chooses.
- **Not here:** a worker as a process of its own (a manifest has one process); pooling through the instance's PgBouncer (the migrations hold a session lock, so the manifest does not declare `database.pooling`); `FJORD_ENCRYPTION_KEY` made by the instance (it must be exactly 32 bytes, and an instance makes 48 until the manifest can say how many).

## What it asks of Sovereign

Changes proposed to `sovereignfs/sovereign`, each justified for any app and none naming Fjord, to be written there as an RFC:

- **One manifest file, and a shared package for it:** `sovereign.manifest.json` at the app's source root is the manifest, and the image label is made from it at build time by a published `@sovereignfs/manifest` (schemas, a validator, `sovereign-manifest check | label | docker-args`), not copied by hand into a Dockerfile. `sv` gives every hosted app `PORT` from the manifest's `port`, so the manifest is the one place the port is written.
- **Manifest 2:** `prefix` in lowercase (`"prefix": "fjord"`; the variables are its upper case), also the default name in `sv app add`; `signIn` optional, so that signing in through core is an app's choice; `generate` entries that say how many bytes.
- **The SDK's logout and account-deleted tokens verifiable on their own**, for an app whose sessions are not the SDK's (Fjord's are better-auth's).

## H1 Settings under Sovereign's names

**Status:** ✅ Done

Every variable Fjord Web reads starts `FJORD_`, and a setting that Sovereign's `contracts/env.md` names has that name: the database (`FJORD_DB_DIALECT` = `sqld | sqlite | postgres`, `FJORD_SQLD_URL`, `FJORD_SQLD_ADMIN_URL`, `FJORD_SQLITE_URL`, `FJORD_POSTGRES_URL[_FILE]`, `FJORD_POSTGRES_POOL_MAX`), email (`FJORD_SMTP_*`) and Sovereign sign-in (`FJORD_CORE_URL`, `FJORD_CORE_CLIENT_ID`, `FJORD_CORE_CLIENT_SECRET[_FILE]`). An instance's `suite.yml` can set only prefixed names, and gives a hosted app its database and client under exactly these.

**Accepts when:** the app starts from the new names alone, in each of the three setups; an environment written for 0.1.0 starts unchanged and the log names each old variable it read; an old name beside its new one stops the server naming both; the PostgreSQL address can come from a file.

- **Done as:** `src/env-renames.ts` maps the old names onto the new ones inside each reader (`src/db/config.ts`, `src/auth/config.ts`), so the rest of the app knows only the new names. The database's old names map as a set, since `SQLITE_URL` named an sqld service or a file: `DB_DIALECT=sqlite` (or none) becomes `sqld` for an address and `sqlite` for a `file:`. Mixing old and new database names is refused; the other renames are refused per pair, `_FILE` forms included. The start-up hook prints each old name with its new one and never a value. The compose files, `.env.example`, the dev and check scripts, the browser tests and CI use the new names; the test-only `FJORD_TEST_*` variables keep their shape.
- **Not as planned:** `FJORD_POSTGRES_DIRECT_URL` is not read yet. It matters only through a transaction pooler, and the manifest will not ask for one (above).

## H2 The manifest and the image

**Status:** ✅ Done

`clients/web/sovereign.manifest.json`:

```json
{
  "manifest": 2,
  "prefix": "fjord",
  "name": "Fjord",
  "description": "Your documents as plain files in a Git repository you control",
  "icon": "/icon.svg",
  "port": 3000,
  "health": "/api/health",
  "launch": "/",
  "signIn": {
    "redirect": ["/api/auth/callback/sovereign"],
    "scopes": ["openid", "profile", "email"]
  },
  "database": true,
  "generate": ["FJORD_AUTH_SECRET"],
  "core": ">=0.57.0 <1.0.0"
}
```

No `postLogout` (signing out of Fjord is local), no `offline_access` (Fjord calls no Core API), no `data` (on PostgreSQL nothing on disk must survive). The release and CI image builds set the label and the `PORT` build argument from the file (`ARG PORT`, `ENV PORT=${PORT}`, `EXPOSE ${PORT}`), CI validates the file against the schema and checks the built image's label equals it, and `deploy/README.md` gains "Hosted on a Sovereign instance": `sv app add`, `FJORD_AUTH_SIGNUP: open` and the GitHub App's id and slug in `env`, `FJORD_ENCRYPTION_KEY` and the App's keys in `secrets.age.yml`, and the App's callback at `https://fjord.<domain>/api/github-app/callback`.

**Accepts when:** the image's label validates and equals the file; the image boots with exactly what `sv` gives (`_FILE` secrets, `FJORD_CORE_*`, PostgreSQL) and signs in through the fake Sovereign; it stops cleanly on `SIGTERM`; `/icon.svg` answers.

- **Done as:** the manifest above, as written, with `"core": ">=0.57.0 <1.0.0"`; `scripts/manifest.mjs`, which does what `sovereign-manifest` of `@sovereignfs/manifest` does (`check`, `label`,
  `docker-args` with the same output), because that package is not published and this app takes no dependency that is not on npm, and which the package replaces
  when it is. The image is built with `ARG PORT` (required, so a plain `docker build` stops and says how to build), `ENV PORT=${PORT}`, `EXPOSE ${PORT}` and
  the label, in CI and in the release. `src/sovereign-manifest.test.ts` holds the file to a copy of the manifest's JSON Schema
  (`src/auth/fixtures/app-manifest-v2.schema.json`, taken from `contracts/schemas/app-manifest-v2.schema.json` in sovereignfs/sovereign, and `ajv` is a
  development dependency for it), and to the code and files it names: the sign-in address and scopes (`SOVEREIGN_SCOPES` is now shared by the sign-in and
  the test), the health route, the icon, the secret, no back-channel or account-deleted address, and the port in the Dockerfile and the Compose
  files. `deploy-check.sh` has a fourth check, `sovereign`. `deploy/README.md` has "Hosted on a Sovereign instance".
- **Not as planned:** the icon needed no change (`/icon.svg` is the Next icon route, which the proxy leaves to anyone). SIGTERM ends the image with exit code 143, not 0:
  Next finishes what is in flight and exits with the signal's own code, which is what an orchestrator expects; the check wants it within seconds, not killed
  (137). The Compose files carry the port as a build argument because Compose cannot read the manifest; the test holds them to it.
- **Verified here:** the new test, with ten changes to the manifest each seen to fail it; the image built from the Dockerfile with the manifest's arguments, and the
  `sovereign` check against it, then against four wrong images (no port, no label, another label, another port), each refused; the whole `deploy-check.sh`; the
  app's tests, typecheck and build.
- **Not verified:** a real Sovereign instance hosting it (`sv` and a core were not run), so whether `sv app add` accepts this manifest and a person signs in through
  core is tested only against its schema and the fake Sovereign; the CI and release workflows' new steps, which run only there (the release needs a tag);
  and that `docker/build-push-action` reads the label's JSON as one value.

## H3 Signing out and account deletion from core

**Status:** 📋 Planned (waits on the SDK's token verifiers)

`POST /api/sovereign/backchannel-logout` ends every session of the account linked to the token's `sub`; `POST /api/sovereign/account-deleted` deletes what Fjord holds of the person (the account, its sessions, connections and their credentials, its shares), safe to run twice and answering 200 only when done. Both verify core's tokens with `@sovereignfs/sdk`, pinned exactly as `@sovereignfs/ui` is, and the manifest gains `backChannel` and `accountDeleted`. To decide when it starts: whether comments a person wrote on others' documents are deleted or kept without their name. Repository content is never touched.

**Accepts when:** a signed logout token from the fake Sovereign ends the session and a forged, expired, replayed or other-audience one is refused with 400; a deletion notice removes the person's rows on all three databases, twice is the same as once, and a failure answers 500 so core sends it again.
