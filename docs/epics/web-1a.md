# Fjord Web — 1a — Sign in, connect, browse

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); where it and this file disagree, the design is right. Section numbers (§) refer to it.

## 1a.0 Database layer, both dialects

**Status:** ✅ Done

**Design:** §14

`DB_DIALECT` (default `sqlite`); the libSQL client for sqld and `file:`; the PostgreSQL client; paired Drizzle schemas and migrations; the portability helper; the `event` table; the dev sqld script; CI legs for sqld, `file:` and PostgreSQL.

**Accepts when:** A fresh instance boots on each of the three from the documented variables; migrations apply cleanly from empty on each; the data-layer suite passes on all three in CI; the schema parity test is seen to fail when a column is added to one dialect only.

## 1a.1 Landing page

**Status:** ✅ Done

**Design:** §3

What Fjord is, why, features; sign-in and sign-up.

**Accepts when:** Renders for visitors, as static HTML, in light and dark, on a phone; links to `/sign-in` and `/sign-up`. A signed-in user seeing the repository view at `/` needs a session, so it is 1a.9 (after 1a.2).

## 1a.2 Local auth

**Status:** ✅ Done

**Design:** §6

Email and password, passkeys, TOTP with backup codes; screens built from the design system and shaped by Sovereign's forms (leaving out its invites, terms and timezone). `FJORD_AUTH_LOCAL`.

**Accepts when:** Sign up, sign in, enrol and use a passkey and TOTP, recover with a backup code; off when the variable is unset. Done in a real browser (Playwright, with a virtual authenticator), and on all three databases.

## 1a.3 Sovereign OIDC

**Status:** ✅ Done

**Design:** §6

Authorization code flow against a Sovereign instance; `FJORD_AUTH_SOVEREIGN_*`.

**Accepts when:** Sign in through a real Sovereign instance; `sub`, `email`, `name` used; off when unset. Built as: tests against a fake Sovereign that checks what a real one does, on all three databases and in the browser, and a recording of a real instance's discovery document. Seen end to end against a real instance by hand: consent, back to Fjord, signed in with Sovereign's name and email.

## 1a.4 Account linking when both are on

**Status:** ✅ Done

**Design:** §6

*Link Sovereign* from the security page, by `sub`, only from a signed-in session and only when both use the same email address; unlink without losing the last way in; the page of an account that came in through Sovereign has no password settings. Adding a password to such an account is later.

**Accepts when:** Behaviour matches the decision.

- **Done as:** tested over real requests against the fake Sovereign on all three databases and in a browser.

## 1a.5 Provider interface + GitHub

**Status:** ✅ Done

**Design:** §7

List repos, head, tree, blob, multi-file commit, webhooks.

**Accepts when:** Contract tests run against a recorded GitHub API; a second fake provider passes the same tests.

- **Done as:** one contract, run against GitHub over a git-backed fake and against an in-memory provider; and GitHub's real answers replayed.

## 1a.6 GitHub App connection

**Status:** ✅ Done

**Design:** §7

Install, pick repositories, minimal permissions, short-lived tokens, `push` webhooks.

**Accepts when:** Install, pick two repos, see them; a push invalidates the cached tree.

- **Done as:** `src/github-app/`. The operator registers the App (`deploy/README.md`) and sets `FJORD_GITHUB_APP_*`. A person chooses **Install on GitHub** on `/repositories`, picks the repositories on GitHub, and is sent back to `/api/github-app/callback`, which checks a `state` cookie, trades the `code` for the person's own one-use token, asks which repositories of the installation they can reach, and connects those (each checked for content and for write access) as `kind = app` connections that keep only the installation number, encrypted. Tokens for the installation are asked for as needed (App JWT, RS256) and held in memory. `POST /api/webhooks/github` accepts signed `push` events and forgets the trees cached for the connections to that branch. Tested on all three databases with each safeguard broken to see its test fail.
- **Afterwards:** `installation` and `installation_repositories` events disconnect the repositories the App loses.
- **Afterwards:** the head request of every view carries the last `ETag`, so an unmoved branch costs nothing (`src/browse/head-cache.ts`), without trusting the webhook.
- **Left out:** a separate `worker` process and Compose service (decided against until an instance needs it, DESIGN §7); a browser test; and a check against real GitHub, which needs a registered App.

## 1a.7 PAT connection

**Status:** ✅ Done

**Design:** §7

URL + fine-grained token; permissions checked on add.

**Accepts when:** A read-only token is refused with a clear message; a correct one works. Built as: `/repositories` and `/api/connections`, tested against a git-backed fake GitHub on all three databases and in a browser. Seen with real fine-grained tokens on 2026-11-01 (below).

- **Run against the real GitHub on 2026-11-01, and it passed (3 of 3).** It was run as the by-hand workflow `.github/workflows/live-github.yml` (`workflow_dispatch` only, so nothing a pull request or a push does can reach the two repository secrets `FJORD_LIVE_TOKEN_RW` and `FJORD_LIVE_TOKEN_RO`), against `sovereignfs/fjord`: GitHub refused the read-only token as `read_only`, accepted the read-and-write one's no-change write, and told an unknown token and a missing repository apart. Run it again from the Actions tab whenever GitHub's behaviour may have changed, or locally as below. The check is `clients/web/src/connections/live-github.test.ts`: `clients/web/src/connections/live-github.test.ts` is that check, written and skipped until it is given a repository and two fine-grained tokens for it (it never runs in CI). It asserts, against the real API and not the fake: a token with *Contents: Read-only* is refused as `read_only`, with the message that names the permission, and nothing is kept; one with *Contents: Read and write* connects (the no-change write `canWrite` makes, the branch moved to where it already is, is accepted by GitHub), moves nothing (the branch's head is the same after), is kept only sealed (no column holds it or its last twelve characters), and reads the tree back through the stored credential; and a token GitHub does not know is `bad_token` while a repository that does not exist is `not_found`. It writes nothing to the repository. The check's own logic was shown against the git-backed fake, where it passes.

  ```bash
  read -rs FJORD_LIVE_TOKEN_RW && export FJORD_LIVE_TOKEN_RW   # Contents: Read and write, Metadata: Read-only
  read -rs FJORD_LIVE_TOKEN_RO && export FJORD_LIVE_TOKEN_RO   # Contents: Read-only,       Metadata: Read-only
  FJORD_LIVE_REPO=owner/name pnpm exec vitest run src/connections/live-github.test.ts   # in clients/web
  ```

  If GitHub ever answers differently from the fake (the likeliest place is the no-change write for a token without write permission, which GitHub may refuse with another status than 403), the failure names the step and `src/providers/github/provider.ts` `canWrite` is where to fix it, with the fake changed to match what GitHub said.

## 1a.8 Credentials at rest

**Status:** ✅ Done

**Design:** §7, §15

Envelope encryption, key rotation.

**Accepts when:** No plaintext credential in the database; rotation re-wraps all.

- **Done as:** a `credential` table on both dialects and `src/crypto/`; tested on all three databases that no column holds any part of a secret and that a rotation moves every credential to the new key.

## 1a.9 First run and defaults

**Status:** ✅ Done

**Design:** §3, §7

Prompt to add a repository; default repo (first); switcher. The **default vault** moved to 1a.11: it is the first vault in `fjord.json`, which only `fjord-core` (P3, P4) may read.

**Accepts when:** New account is prompted; second visit lands on the default repo.

- **Done as:** `/` and `/repo/<connection>`, `account_default`, tested on all three databases and in a browser.

## 1a.10 Not a Fjord repository

**Status:** ✅ Done

**Design:** §7, decided §19 #3

Shown as such and browsed read-only; an offer to set it up, with the exact files shown first, and nothing written before a click; one additive commit of the setup (P6: `fjord.json`, one plaintext vault, and the `.gitattributes` merge guard only where it is missing), never forced. Not offered when the token cannot write or `fjord.json` is there but unreadable; a vault name already taken is not reused. An empty repository is not covered.

**Accepts when:** A repository without `fjord.json` is offered the setup; declining writes nothing; accepting makes one commit that only adds files and passes `fjord verify`; a head that moved in the meantime is read again, not overwritten. Tested against the git-backed fake GitHub on all three databases and in a browser.

- **Done as:** `src/browse/setup.ts` (assess, apply), `POST /api/connections/<id>/setup` and the offer on the repository page; the plan is `fjord-core`'s, through the module. Not covered: an empty repository, and a repository with vaults but no `fjord.json`.

## 1a.11 File browser

**Status:** ✅ Done

**Design:** §8

Vaults from the listing (P3), and each repository's default vault (§7: the first in `fjord.json`, until the user picks another), documents and notes openable, others greyed, encrypted vaults locked; lazy metadata; tree cache by commit.

**Accepts when:** Matches `fjord ls` on the fixtures; a large repo falls back to per-directory listing; nothing downloaded to draw it. **In three steps.** First, done: the format module wired in, the vaults of a repository from the head, the cached tree and the manifests, with counts by kind and a lock, the large-repository fallback to find the vaults, and every failure a host can cause said plainly. Second, done: browsing a vault's folders and files at `/repo/<connection>/<vault>/<path>`, documents and notes as links, other files greyed, encrypted vaults locked, the cut-short listing browsed a directory at a time and read the same. Third, done: each repository's default vault: the vault the account chose, until then the first `fjord.json` lists (a listed vault that is not there is skipped), shown at `/` and `/repo/<connection>`; the choice is `connection.default_vault`, set with `PUT /api/connections/<id>/vault`. Tested on all three databases and in a browser.

## 1a.12 Deployment

**Status:** ✅ Done

**Design:** §17

Image, `web` and `worker`, carrying the third-party notices (`@sovereignfs/ui`'s `NOTICE`: Lucide's ISC licence, which asks that its notice travel with copies); compose with the sqld service, a single-container `file:` example and a PostgreSQL overlay; backups for each; configuration; a staging instance.

**Accepts when:** A fresh instance comes up from the documented variables in each of the three database setups.

- **Done as:** `Dockerfile` (a Rust stage for the format module, a standalone Next.js server, a runtime of about 100 MB with the licences) and `deploy/` (compose files for sqld, a file and a PostgreSQL overlay, `.env.example`, a README with the proxy, backups and updating); `scripts/deploy-check.sh` brings each up from nothing, makes an account, restarts keeping the volumes and signs in, and CI runs it (job `image`). Not yet: the `worker` (nothing to run until 1b.9 and the webhooks of 1a.6), and a staging instance, which is an operator's. **Release, added later:** a `web-v*` tag builds the image for amd64 and arm64 on native runners, publishes `ghcr.io/<owner>/fjord-web` (`X.Y.Z`, `X.Y`, `latest`), attests its provenance, pulls it by digest and runs `deploy-check.sh file` against it, and only then publishes the release page (`.github/workflows/web-release.yml`, `RELEASING.md`). Versions follow a written policy (patch: no migration, enforced by `release.sh`; minor: migrations, forward-only; a released migration is never edited, also enforced), and `deploy/README.md` § Updating says how to upgrade and how to go back.
