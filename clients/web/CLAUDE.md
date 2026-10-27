# Build brief: Fjord Web

Instructions for whoever builds `clients/web`, human or model. The repository-wide
rules in the root [`CLAUDE.md`](../../CLAUDE.md) apply here too: one task, one
branch, one draft PR; commits explain why; docs are part of the change; nothing
goes to `main` directly.

[`DESIGN.md`](DESIGN.md) is the design and [`ROADMAP.md`](ROADMAP.md) the order of
work. Where this file and the design disagree, the design is right and this file
should be fixed; where either disagrees with [`spec/SPEC.md`](../../spec/SPEC.md),
the spec is. Build the roadmap's tasks in order, and check each one's "Accepts when".

## Commands

```bash
pnpm install --frozen-lockfile   # never `pnpm install` in CI or a PR check
pnpm typecheck                   # next typegen && tsc --noEmit
pnpm test                        # vitest
pnpm build                       # next build
pnpm dev
pnpm db:generate <name>          # migrations for both dialects, from the schemas
pnpm db:dev sqld | postgres      # a local database in Docker (not needed: a file: URL works)
pnpm build:wasm                  # the format module (Rust + wasm-bindgen); the tests that need it skip without it, CI requires it
FJORD_CLI=…/target/debug/fjord pnpm test   # also runs the check that created files pass the real `fjord verify` (cargo build -p fjord-cli first)
pnpm build:editor                # packages/fjord-editor, built: the app imports it, so run it before typecheck, build and dev
pnpm build && pnpm boot-check    # a fresh instance boots on the database in the environment
pnpm build && pnpm e2e           # browser tests (Playwright; `pnpm exec playwright install chromium` once)
docker build -f clients/web/Dockerfile -t fjord-web:ci .   # the image, from the repository's root; then:
FJORD_IMAGE=fjord-web:ci clients/web/scripts/deploy-check.sh   # it in each of the three setups
```

Node 24 and the pnpm version in `package.json`. A change to a dependency commits
`pnpm-lock.yaml` with it.

## Rules

- **Never reimplement the format.** Manifests, vault discovery, path rules,
  frontmatter and encryption are `fjord-core`, compiled to WebAssembly
  (`crates/fjord-wasm`, loaded by `src/format/`; build it with `pnpm build:wasm`).
  If the module does not offer something a task needs, add it to the module; do not
  write a stand-in parser. What a file is comes from the module, given a listing.
  The conformance fixtures in `tests/fixtures/` are the test, and the web's tests
  hold it to what the CLI says about them.
- **The server talks to the git host; the browser never does.** Credentials are
  encrypted at rest and never sent to the client, written to a log, put in a URL or
  shipped in a bundle (`DESIGN.md` §7, §15). Share tokens are redacted from logs
  (§12).
- **Every route and API checks the caller's role** before it does anything
  (`DESIGN.md` §12). A new endpoint without a test of who may call it is not done.
- **The database has two dialects and three test legs** (`DESIGN.md` §14): a schema
  and migrations per dialect, generated with `pnpm db:generate` and never written by
  hand or `push`ed; one representation per type, through the column vocabulary in
  `src/db/schema/*/columns.ts` (a 64-bit id or an `epochMs`, never a `Date` or a bare
  `bigint`); no `LISTEN/NOTIFY`, the `event` table instead; short transactions,
  nothing held across a call to the git host. Raw SQL goes through `src/db/exec.ts`
  and is standard SQL, with values bound and never interpolated. A data-layer test
  runs on sqld, a `file:` database and PostgreSQL, so one that only passes on one is
  not done. A schema change is made in both dialects, and its migrations committed
  with it: CI fails if generating from the schemas would write anything.
- **Tests that drop data never read the app's variables.** They read `FJORD_TEST_*`
  (`src/db/test-support.ts`), so a developer's exported `POSTGRES_DB_URL` can never
  be wiped by `pnpm test`.
- **The design system comes through `src/ui`, and its tokens are the only palette.**
  `@sovereignfs/ui` is one bundle with no `"use client"` and a module-level
  `createContext`, so a Server Component that imports it directly fails to build;
  import from `src/ui` (a `"use client"` re-export, which still renders on the
  server). Add a component there when a page needs it. Style with the `--sv-*`
  tokens (`@sovereignfs/ui/tokens.css`), never a literal colour, so dark mode and
  theming keep working. The typeface is Hanken Grotesk through `next/font/google` in `app/layout.tsx`,
  as Sovereign loads it (self-hosted at build time, never a request to Google from the browser; a
  `<link>` to a font service is not allowed). The package's README is out of date: take icon names and
  props from its types (`IconName`; `Icon` needs `aria-hidden` or `aria-label`). It
  has `@dnd-kit/*` peers that it imports unconditionally, so they are installed too.
- **Sign-in is tested for what it promises, over real requests.** A test of an auth flow goes
  through `auth.handler` (cookies, `Origin`) against the real databases, not a mock of
  better-auth (`src/auth/test-support.ts`), and anything a browser alone can show goes in
  `e2e/`. A security behaviour (the origin check, the lockout, ending sessions on a reset, the
  first-account rule) has a test that was seen to fail with the behaviour switched off. Every
  auth page is `force-dynamic`: with no settings at build time local sign-in is "off", and
  Next would prerender a 404 and keep it. No message says whether an address has an account.
  A change to what better-auth stores is a change to both dialects' `schema/*/auth.ts`. Sovereign
  sign-in is tested against `src/auth/testing/fake-sovereign.ts`, never the real service (the
  real one's public discovery document is recorded and compared); a change to it keeps it as
  strict as Sovereign is. A Sovereign login is known by its `sub`, never matched to an account by
  email at sign-in: it is linked only from a signed-in session, and only when the address is the
  account's own (DESIGN.md §6).
- **A credential is stored only through `src/crypto/`** (`CredentialStore`: envelope encryption under
  `FJORD_ENCRYPTION_KEY`), never as text in a column, and a table that holds one holds its id. Read it
  back on the server where it is used, never send it to the browser or put it in an error, a log or a
  URL. A change to how it is sealed keeps the binding to the row and purpose, and has a test seen to
  fail with that switched off.
- **A route that changes something is tested for who may call it and from where.** `src/connections/http.ts`
  is the pattern: the caller is found by the route and handed in, the rules (signed in, this site's
  `Origin` on every write, an account's own rows only, another's is 404) are tested directly with a stand-in
  service, and each was seen to fail with the rule switched off.
- **A git host is reached only through `Provider`** (`src/providers/`), and the app is tested
  against `MemoryProvider`, not against GitHub. A new host is a new implementation that passes
  `providerContract`. A commit is never forced and never retried; `head_moved` is the app's cue to
  read again and decide. A credential never appears in an error, a log or a URL. Re-record
  `src/providers/github/fixtures/` with `node scripts/record-github-fixtures.mjs` (no credential
  needed) when GitHub's shapes may have changed, and read the diff before committing.
- **Untrusted Markdown is sanitised** and pages send a strict
  Content-Security-Policy (`DESIGN.md` §15). Nothing third-party loads.
- **TypeScript is strict**, with `noUncheckedIndexedAccess`. No `any` without a
  comment saying why it cannot be avoided.
- **Dependencies are chosen, not accumulated.** `@sovereignfs/ui` is pre-1.0 and is
  pinned to an exact version; upgrade it on purpose. A dependency's licence must be
  compatible with AGPL-3.0-or-later, and nothing here is imported by the MPL-2.0
  parts of the repository.
- **A change to behaviour adds a line under `## [Unreleased]`** in `CHANGELOG.md`.
  A statement in `README.md`, `DESIGN.md` or `ROADMAP.md` that the change makes
  false is fixed in the same PR.

## Where things go

| Path | What |
| --- | --- |
| `app/` | Next.js routes and layouts (App Router) |
| `src/` | Everything that is not a route: the data layer, providers, auth, the format glue. Tested with Vitest, `*.test.ts` beside the code |
| `src/ui/` | The design system's client boundary, and components of ours that match it (`LinkButton`) |
| `src/landing/` | The landing page at `/`: its content as typed data, the component and its styles |
| `src/theme/` | The script that sets `data-theme` from the visitor's colour scheme, before first paint |
| `src/auth/` | Sign-in, local and Sovereign: its settings, the better-auth instance, the client, the screens (`screens/`), the test harness, and a fake Sovereign (`testing/`) with a recording of a real one's discovery (`fixtures/`) |
| `src/crypto/` | Credentials at rest: the instance key (`config.ts`, `keyring.ts`), envelope encryption (`envelope.ts`), the `credential` table's store and the start-up rotation (`store.ts`) |
| `src/connections/` | The repositories an account has connected: the address parser, the service that checks a token before keeping it, the HTTP rules (`http.ts`), the screens (`screens/`) |
| `src/format/` | The format: the WebAssembly module's loader and the types of what it answers (`wasm.ts`, `types.ts`). Nothing else in the app knows the format |
| `src/browse/` | Reading a repository from its git host to show it: the head, the cached tree, the manifests, and `fjord-core`'s discovery of the vaults (`repository.ts`), the `tree_cache` (`tree-cache.ts`), what to say when the host fails (`problems.ts`), where a path inside a vault leads (`location.ts`), which vault a repository opens on (`default-vault.ts`), setting up one that is not a Fjord repository (`setup.ts`, the plan is `fjord-core`'s), and a note's or document's header: where its body starts, its properties and the header a file with none is given on its first edit (`document.ts`; the panel is `screens/DocumentProperties.tsx`), and finding a file by its Doc `id`: the `doc_index` store (`doc-index.ts`), the resolver that believes a row only where its blob is still the repository's and searches a bounded share on a miss (`ids.ts`), and the screens of `/doc/<id>` and `/note/<id>` (`screens/IdPage.tsx`, which shows the file with `screens/RepositoryScreen.tsx`, the one screen `/repo/…` is too) |
| `src/working/` | Drafts of files being edited and the versions made of them (ROADMAP 1b.8, 1b.9): the `working_copy` store and its rules (`service.ts`), who may keep which (`access.ts`), making a version, one commit (`version.ts`), going on after the file changed (`resolve.ts`), the HTTP rules (`http.ts`, `context.ts`), and the browser's saver (`saver.ts`, `client.ts`) |
| `src/files/` | Making, deleting and restoring files (ROADMAP 1b.7, 1b.12; renaming and moving join it): the commit that adds one (`create.ts`), removes them (`delete.ts`) or puts them back, never over anything (`restore.ts`), the record of what was deleted (`deletions.ts`, the `deletion` table), the restore window (`config.ts`), the offer to undo (`undo.ts`), whose and where (`access.ts`), the HTTP rules (`http.ts`, `context.ts`), renaming and moving, one commit of the same blobs at new paths (`move.ts`, its HTTP rules `handleMove` in `http.ts`, and the controls `browse/screens/MoveButtons.tsx`), the title written into a header (`http.ts` `handleHeader`, a pure rewrite by the format module with no repository access), the browser's request (`client.ts`), and the check that what it makes is accepted by the real CLI (`cli.test.ts`, which needs `FJORD_CLI`) |
| `src/mail/` | Sending email: the SMTP mailer, a mailer for tests, the templates |
| `Dockerfile`, `deploy/` | The container image (it builds the format module itself, so it is built from the repository's root) and the Compose setups for sqld, a file and PostgreSQL, with their README and `.env.example`; `scripts/deploy-check.sh` brings each up from nothing and CI runs it. The server exits on a setting that is wrong (`instrumentation.ts`): the image's own server would otherwise stay up |
| `e2e/` | Browser tests, and `playwright.config.ts` for the five instances they run against (and the fake Sovereign two of them sign in through) |
| `proxy.ts` | Shows a signed-in person `/home` at `/`; only looks for a cookie |
| `src/providers/` | The git host interface (`types.ts`), GitHub's implementation (`github/`), an in-memory one (`memory.ts`), and the contract and the git-backed fake they are tested with (`testing/`) |
| `src/db/` | The database layer: configuration, the two clients, the schemas (`schema/{sqlite,postgres}`), portable queries, migrations at start-up |
| `migrations/` | The generated SQL, `sqlite/` and `postgres/` for the app's store and `auth/` for better-auth's, committed and reviewed |
| `instrumentation.ts` | Runs once at server start: brings the database up, so a server that cannot reach or migrate it does not start |
| `scripts/` | Small Node scripts: `db-generate`, `db-dev`, `boot-check`, `record-github-fixtures`, `record-sovereign-discovery` |
| `DESIGN.md`, `ROADMAP.md` | The design and the plan |

`packages/fjord-editor` is shared with other clients (ROADMAP 1b.1, 1b.2, 1b.3; its own `CLAUDE.md`). Its document editor is MDXEditor, loaded on demand and used only for a document it can hold without changing what it means; the page gives it the body and keeps the header (`src/browse/document.ts`). It is
**MPL-2.0** and must not import `@sovereignfs/ui` or anything else of this app's (`DESIGN.md` §18).
The app imports it as a `link:` dependency, through its interface only (`fjord-editor` and `fjord-editor/styles.css`), and it must be built first (`pnpm build:editor`). Its look comes from `--fe-*` custom properties that `app/globals.css` maps the `--sv-*` tokens onto.
