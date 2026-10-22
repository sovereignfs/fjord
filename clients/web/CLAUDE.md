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
  and migrations per dialect, generated with `drizzle-kit generate` and never
  `push`; one representation per type; no `LISTEN/NOTIFY`; short transactions,
  nothing held across a call to the git host. A data-layer test runs on sqld, a
  `file:` database and PostgreSQL, so one that only passes on one is not done.
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
| `DESIGN.md`, `ROADMAP.md` | The design and the plan |

`packages/fjord-editor` is shared with other clients and is created when slice 1b
starts (ROADMAP 1b.1), not before.
