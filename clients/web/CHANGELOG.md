# Changelog

All notable changes to `fjord-web` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release's section is also its GitHub release notes: the release workflow
reads this file when a release is cut. Write the notes under `## [Unreleased]`
as you go; `scripts/release.sh web prepare` turns them into the version's
section.

## [Unreleased]

### Added

- **The git host interface and GitHub** (ROADMAP 1a.5): list repositories, read a branch's
  head (with etags), a commit's whole tree or one directory, and a file; make several file
  changes as one atomic commit, never forced and never retried; verify `push` webhooks.
  Errors are typed (`head_moved`, `rate_limited`, `forbidden`, ...). Not yet connected to
  anything: the GitHub App and token connections are the next tasks.
- **Local sign-in** (ROADMAP 1a.2): email and password, passkeys, and two-factor with an
  authenticator app and ten backup codes, on better-auth 1.7. Off unless `FJORD_AUTH_LOCAL`
  is set, and then off entirely (404). Sign-up is the first account only unless
  `FJORD_AUTH_SIGNUP=open`. Email is optional: with `SMTP_*`, addresses are verified and a
  password can be reset by a mailed link that ends every session. Screens for sign-in,
  sign-up, the two-factor step, reset, and an account security page; a signed-in person sees
  `/home` at `/`. Run it behind a proxy that sets `X-Forwarded-For`.
- Browser tests (Playwright, Chromium, a virtual authenticator for passkeys), and a CI job.
- **The landing page** (`/`, ROADMAP 1a.1): what Fjord is, why, what it does, how it
  works and a FAQ, with sign-in and sign-up links. It is static HTML in the design
  system's tokens (`@sovereignfs/ui`, pinned), follows the visitor's light or dark
  setting, works without JavaScript and on a phone, and says plainly that Fjord Web is
  still being built. The sign-in and sign-up pages are the next task.
- **The database layer** (`DESIGN.md` §14): SQLite by default, as an sqld service or a
  plain file, or PostgreSQL by choice, selected by `DB_DIALECT`. The server makes its
  own namespaces, schemas and tables when it starts and refuses to start if it
  cannot. Paired Drizzle schemas and generated migrations, an `event` table for
  worker-to-web notices, portable query helpers, `GET /api/health`, and
  `pnpm db:dev` for a local sqld or PostgreSQL. CI runs the tests against all three
  databases.
- A placeholder app: Next.js 16 with React 19 and TypeScript, which type-checks,
  tests and builds in CI. Nothing in it is usable yet; the work is planned in
  [`ROADMAP.md`](ROADMAP.md).

[Unreleased]: https://github.com/sovereignfs/fjord/commits/main/clients/web
