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
pnpm build && pnpm boot-check    # a fresh instance boots on the database in the environment
```

Node 24 and the pnpm version in `package.json`. A change to a dependency commits
`pnpm-lock.yaml` with it.

## Rules

- **Never reimplement the format.** Manifests, vault discovery, path rules,
  frontmatter and encryption are `fjord-core`, compiled to WebAssembly (ROADMAP P4).
  Until that exists, a task that needs one of them waits for it; do not write a
  stand-in parser. The conformance fixtures in `tests/fixtures/` are the test.
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
  theming keep working. The package's README is out of date: take icon names and
  props from its types (`IconName`; `Icon` needs `aria-hidden` or `aria-label`). It
  has `@dnd-kit/*` peers that it imports unconditionally, so they are installed too.
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
| `src/db/` | The database layer: configuration, the two clients, the schemas (`schema/{sqlite,postgres}`), portable queries, migrations at start-up |
| `migrations/` | The generated SQL, `sqlite/` and `postgres/`, committed and reviewed |
| `instrumentation.ts` | Runs once at server start: brings the database up, so a server that cannot reach or migrate it does not start |
| `scripts/` | Small Node scripts: `db-generate`, `db-dev`, `boot-check` |
| `DESIGN.md`, `ROADMAP.md` | The design and the plan |

`packages/fjord-editor` is shared with other clients and is created when slice 1b
starts (ROADMAP 1b.1), not before.
