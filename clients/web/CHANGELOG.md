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

- **First run and defaults** (ROADMAP 1a.9): an account with no repository is prompted, at `/`, to
  connect its first. The first repository an account connects is its default, and `/` is that
  repository's page (`/p/<connection>` for any of its own, a 404 for anyone else's), with a switcher
  between repositories and *Make this my default* (`POST /api/connections/<id>/default`, signed in,
  this site's origin, the caller's own). Disconnecting the default moves it to the first one left. New
  `account_default` table. The default vault is not here: it needs `fjord.json` read by `fjord-core`
  (P3, P4), and moves to 1a.11.
- **Connect a repository with a token** (ROADMAP 1a.7): on `/repositories`, an address and a
  fine-grained GitHub token. It is checked before anything is kept (accepted, can see the
  repository, not empty, can write, found out by a no-op update of the branch, never forced), a
  token that fails leaves nothing behind, and the one that passes is stored encrypted. A token that
  can reach other repositories is accepted with a warning. `/api/connections` answers only the
  signed-in account's own, from this site's own pages. New `connection` table and
  `FJORD_GITHUB_API_URL` (for Enterprise Server). Nothing yet reads a connected repository: browsing
  and defaults are 1a.9.
- **Credentials at rest** (ROADMAP 1a.8): a `credential` table that holds secrets only as
  envelope encryption (AES-256-GCM, a data key per credential wrapped under an instance key
  from `FJORD_ENCRYPTION_KEY`), bound to its row and purpose so it cannot be moved to another.
  Rotation is a restart with the old key in `FJORD_ENCRYPTION_KEY_PREVIOUS`: every credential is
  re-wrapped, none re-encrypted. The server will not start with credentials it could never
  open. Nothing stores a credential yet; the connections (1a.6, 1a.7) will.
- **Sovereign's typeface and a new icon.** The app is set in Hanken Grotesk, loaded as
  Sovereign's own apps load it, through `next/font`: it is downloaded when the app is built
  and served from our own origin, so visitors' browsers never contact Google (the build needs
  network access to fetch it). The tab icon now reads "Fj".
- **Sign-in through Sovereign** (ROADMAP 1a.3): OpenID Connect against a Sovereign instance
  (RFC 0072), by authorization code with PKCE, switched on by `FJORD_AUTH_SOVEREIGN_ISSUER`,
  `_CLIENT_ID` and `_CLIENT_SECRET`. Either way in, or both, can be on; with neither, sign-in
  is off. A person is known by their Sovereign `sub`, never by an email address that matches a
  local account (such a login is refused until linking exists, 1a.4); `email` and `name` are
  copied; the ID token must verify against the issuer's keys, and the tokens are stored
  encrypted. Signing out of Fjord does not sign out of Sovereign. `FJORD_AUTH_SIGNUP` applies
  to both ways in, and a refused Sovereign login comes back to the sign-in page with the
  reason. Tested over real requests against a fake Sovereign on all three databases, in the
  browser, and against a recording of a real instance's discovery document.
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
