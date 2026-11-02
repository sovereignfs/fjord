# Workstream 0001 — Repository kinds

**Status:** ⏳ In progress, leg 2 (leg 1 done and its gate passed, 2026-11-02)\
**Date:** November 2026\
**Author:** Claude Code, from a design conversation with the owner\
**Goal owner:** the repository's owner (kasunben)\
**Governs:** [RFC 0001](../rfcs/0001-repository-kinds.md); spec §2, §3, §8.1, §11.2; [`docs/epics/web-3.md`](../epics/web-3.md)
(P9–P12, 3a–3d)\
**Research:** [Research 0001 — The `ssg` kind](../research/0001-ssg-kind.md)

---

## Goal

A Fjord repository says what it is for, and opens as that. A **drive** is today's vaults and folders. A **journal** is a
timeline of dated entries, several a day, filtered by tags, and can be encrypted without revealing its dates. An **`ssg`**
repository is an Astro or Jekyll site whose posts are written in Fjord Web, whose build status shows there, and whose changes
can be previewed through the site's host. The format gains one optional field, two rules and a `date` key. Every repository
stays readable, and buildable, without Fjord.

## Definition of done

- [x] The spec defines `kind`, its settings object, the fallback to `drive`, the one-vault rule, plaintext `ssg`, `date` and tag
      comparison, with a fixture for each new code (P9).
- [x] `fjord init --kind` makes each kind, `fjord verify` checks each, and `fjord new` makes a journal entry (P10, P11).
- [x] `fjord-wasm` answers the kind and an entry's path, and its fixture tests agree with the CLI (P12).
- [ ] Fjord Web opens each kind on its own view, a kind it does not know as a drive, and every kind as files on request (3a).
- [ ] A journal can be made, written and read as a timeline, with tags, plaintext or encrypted, and an encrypted journal's
      dates, titles and tags never reach the server (3b).
- [ ] An Astro and a Jekyll site can be made, their posts written with fields, and their build status shown (3c).
- [ ] A change to a site can be previewed through a host that previews branches (3d.1).
- [ ] RFC 0001's status says it is implemented; `clients/web/DESIGN.md` holds the design (3a.1 moves it there).

## Decisions locked

Settled with the owner on 2026-11-02. An agent running this workstream cannot see that conversation: do not reopen these
without asking.

| Decision | Choice | Rejected alternative and why |
| --- | --- | --- |
| Where the kind lives | `fjord.json`, the **repository** | Per vault: one repository is one thing to the person, and hosts deploy a site per repository |
| The IDs | `drive`, `journal`, `ssg`; absent means `drive` | `files` (less concrete); `site` for `ssg` (proposed, declined by the owner; the RFC records why it was proposed) |
| What a kind is | A presentation hint, as `*.fj.md` is (§8.4): unknown kinds open as `drive`, any repository can be shown as files, changing a kind loses nothing | A kind that changes what files mean, or a client refusing a kind it does not know |
| Vaults of `journal` and `ssg` | **Exactly one**, never shown in the UI; found by its `fjord.vault.json`; folder name not fixed (the scaffold uses `journal/`, `content/`) | The root as the vault (collides with §2 and §6); fixed folder names (a reserved name per kind) |
| Encryption | Unchanged, in the one vault's manifest: optional for a journal, never for `ssg` | Encryption in `fjord.json` |
| Drive | Unchanged: many vaults, each with its own encryption | Making it one vault like the others |
| Entry dates | A spec-defined `date` key, RFC 3339 **with the writer's local offset**; a full-date alone allowed; not `created` | UTC (puts late entries on the wrong day); reusing `created` (set once, about the file) |
| A `date` that is not RFC 3339 | A warning (`W606`), never an error | An error (would fail Jekyll sites and files from other tools) |
| Entries a day | Several. Plaintext journal: `YYYY/MM/DD/HHMM[-slug].md` from `date`, a convention only, `date` wins | One entry per day |
| Encrypted journal layout | Entries at the vault's root, `fileNaming: "id"`, tar container; no dated folders | Dated folders (directory names are never encrypted, §11.2) |
| Timeline and tag index | Derived, never committed; for an encrypted journal, built and kept in the browser only | A committed index; a server-side index of decrypted data |
| Tags | §8.1's `tags`; case-insensitive (NFC, then the lowercase mapping, which every client's library has: P9), `/` nests; stored as written; frontmatter only; one index shared by every kind | `#tags` in the text; exact matching; an index per kind |
| SSG layout | Fjord scaffolds the site, with the engine reading content from the one vault (`content/`) | Declaring the engine's own content folders (an import feature, later, with its own RFC) |
| SSG scope | Content editing first, then previews through the host. A build in Fjord only with its own RFC and security review. Fjord never publishes | Building or publishing in the first version |
| SSG content model | Fixed per engine in this workstream | A per-site model (an open question of Research 0001) |
| Order | Fjord Web's phase 3, before collaborative editing (now phase 4). Format, then Drive, then Journal, then SSG, then preview | Collaborative editing first; SSG before Journal |

## Prerequisites

- **RFC 0001 accepted** by the owner (its **Status** line changed), with any change to the decisions above written back here
  first. Leg 1 changes the format; nothing starts before this.
- **A Rust toolchain** for leg 1 (and `pnpm build:wasm` for the web legs), as for P7 and P8.
- Fjord Web's phases 1 and 2 are built (they are, November 2026), so the editors, encrypted vaults in the browser and the shared
  vault planner (2d.1) exist to build on.

## Legs

| Leg | Name | Epic tasks | Gate? | Done when |
| --- | --- | --- | --- | --- |
| 1 | The format | P9, P10, P11, P12 | **Yes**: the spec text is reviewed before any client depends on it | Each kind's scaffold verifies; every new fixture emits only its code; `fjord-wasm` agrees with the CLI |
| 2 | Kinds in the web client | 3a.1, 3a.2, 3a.3 | No | Every existing repository looks exactly as before; a repository of each kind can be set up from the web and verifies |
| 3 | Journal | 3b.1, 3b.2, 3b.3 | No | A journal is written and read by date and tag, plaintext and encrypted, with the privacy test of 3b.2 passing |
| 4 | SSG | 3c.1, 3c.2, 3c.3 | **Yes**: the scaffold and content model are reviewed against real builds before previews are built on them | A post written in Fjord builds with each engine; build status shows |
| 5 | Preview | 3d.1 | No | A preview link shows for a preview branch, and the default branch is never written |

Each task is its own branch and draft PR; a leg ends at its review gate ([README](README.md#legs)). 3d.2 is outside this
workstream until it has an RFC.

## Leg detail

### Leg 1 — The format

**Epic tasks:** P9, P10, P11, P12

**Why here:** every client reads the format through `fjord-core`, and the web client may not reimplement it
(`clients/web/CLAUDE.md`). Nothing in legs 2 to 5 can be built until the module answers the kind.

**Technical notes:**

- The precedent is P1 (`*.fj.md`, [`web-prerequisites.md`](../epics/web-prerequisites.md)): a spec amendment, fixtures, then
  core, CLI and module in turn, each its own PR.
- `crates/fjord-core/src/manifest.rs` reads `fjord.json`: `kind` and the settings object must round-trip through it with
  unknown values intact (invariant 3). Add the property test beside the frontmatter one.
- `crates/fjord-core/src/diagnostics.rs` is the one source of truth for codes. The CLI README's tables are held to it by
  `crates/fjord-cli/tests/readme_diagnostics.rs`. The RFC's `E111`, `E112` and `W606` are proposals: check the next free
  numbers there (`E107`, `E205` and `W603` are withdrawn and never reused).
- `crates/fjord-core/src/scaffold.rs` is P6's scaffold-as-data. Each kind is a new plan from it, and the CLI's `init` and the
  web's setup (`clients/web/src/browse/setup.ts`) both use it.
- `ls --json` already has a field named `kind` (a file's kind, P2). `verify --json`'s repository kind needs a name that does
  not clash, and `schema/verify.schema.json` gains it.
- An entry's path is computed in the writer's local time. The pure subset takes no clock (root `CLAUDE.md`), so the caller
  passes the `date`, offset included.

**Do not proceed if:** RFC 0001 is not accepted; or the spec text, once drafted, needs a new format version (`fjord: 2`). That
would mean a decision above was wrong, so stop and ask.

### Leg 2 — Kinds in the web client

**Epic tasks:** 3a.1, 3a.2, 3a.3

**Why here:** the module interface has to exist before a second kind is built on it, and Drive, which is today's behaviour,
proves it changes nothing.

**Technical notes:**

- Today's browsing is `clients/web/src/browse/` (`repository.ts` reads the manifests, `default-vault.ts` chooses where a
  repository opens, `screens/RepositoryScreen.tsx` draws it). The kind comes from the module's discovery, never parsed in
  TypeScript.
- 3a.3 extends 1a.10's setup offer and 2d.1's vault planner (`add-vault.ts`): one plan from `fjord-core`, previewed, one
  commit, checked by the real CLI in `cli.test.ts`.
- Every new route goes in `src/access/routes.ts`, or `routes.test.ts` fails.
- 3a.1 moves the RFC's design into `clients/web/DESIGN.md` (replacing the stub in §8) and marks the RFC implemented in part.

**Do not proceed if:** 3a.2 cannot be done without changing what an existing repository shows. The module interface is wrong.
Stop and revise 3a.1.

### Leg 3 — Journal

**Epic tasks:** 3b.1, 3b.2, 3b.3

**Why here:** it is small, it needs nothing outside Fjord, and it tests the shared tag and timeline index that SSG reuses.

**Technical notes:**

- An encrypted journal's entries are opened by phase 2's code (`clients/web/src/encrypted/`, `src/keys/`). The timeline of
  one is built in the browser from what that code decrypts. The privacy test reads every request the page sends, as 2a.1's
  test does for keys.
- The plaintext index can follow `doc-index.ts`'s pattern: rows believed only while their blob is the repository's.
- Tag comparison (NFC, case folding, `/`) belongs in `fjord-core` and the module, so the CLI and every client agree. Add it to
  P10 and P12 if leg 1 left it out.

**Do not proceed if:** the timeline of an encrypted journal cannot be built without sending a date, title or tag to the
server. Stop: that breaks a decision above.

### Leg 4 — SSG

**Epic tasks:** 3c.1, 3c.2, 3c.3

**Why here:** it reuses legs 2 and 3, and it is the leg with the most unknowns (Research 0001's **to confirm** list).

**Technical notes:**

- 3c.1 starts with the spike. Its findings are written into `web-3.md` and, where they change a finding, into Research 0001.
- Build status is read through the `Provider` (`clients/web/src/providers/`). The contract (`providerContract`) and
  `MemoryProvider` grow a read of a commit's statuses, and the GitHub fixtures are re-recorded
  (`scripts/record-github-fixtures.mjs`).
- Building a scaffold with Astro or Jekyll needs Node or Ruby toolchains. Keep that out of the Rust matrix: a job of its own,
  or a recorded check in the epic, decided in 3c.1.

**Do not proceed if:** an engine cannot read its content from a root vault without changes to its own code. Then the scaffold
approach fails for it: record it in Research 0001 and ask before going on with the other engine alone.

### Leg 5 — Preview

**Epic tasks:** 3d.1

**Why here:** last, and after a gate, because it writes branches the person did not make, and it depends on how the hosts
report builds, which leg 4 has then seen for real.

**Technical notes:** a commit goes through the `Provider` as every commit does: never forced, never retried, never to the
default branch. The preview branch's lifetime is decided at the start of 3d.1 and recorded in its epic.

**Do not proceed if:** the only way to get a preview link is an account or token at the host itself. That is a new kind of
credential for Fjord to hold (DESIGN §7, §15), so stop and ask.

## Risks

- **The spec change is permanent.** Field names, codes and the `date` rule are published API once released. Leg 1's gate is
  there for that.
- **Engine releases move.** Astro's content layer has changed across major versions. Research 0001 is dated, and 3c.1's spike
  is the check.
- **An encrypted journal's timeline needs every entry decrypted.** For a large journal that is slow in the browser. 3b.2 pages
  and may cache in the browser, but the privacy rule comes before speed.
- **Two indexes** (timeline, tags) beside `doc_index` add server state for plaintext repositories. Keep them derived and
  disposable, as `tree_cache` is.
- **Scope creep in SSG.** Every content editor tends to grow into a CMS. The content model is fixed per engine here, on
  purpose.

## Kill criteria

- **RFC 0001 is not accepted**, or is accepted with the kind per vault after all: stop and rewrite this workstream from the new
  decisions.
- **Leg 4's gate finds the scaffold approach unworkable** for both engines: stop after leg 3. Drive and Journal stand on their
  own, and `ssg` stays in the spec as a kind clients show as a drive.
- **Leg 5's hosts give no usable preview status**: stop after leg 4. Content editing and build status stand on their own.

## Changelog

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-02 | Initial draft |
| 0.2 | 2026-11-02 | RFC 0001 accepted by the owner; started on one branch, `feat/repository-kinds`, at the owner's request (one commit per task rather than one PR per task) |
| 0.3 | 2026-11-02 | **Leg 1 done** (P9–P12: spec §3.1, §8.1, §11.2; `E111`, `E112`, `W606`; `init --kind`, `verify`'s `repositoryKind`, a journal's `new`; the module's kind, `planKind`, entry paths and tags). Tags compare by the lowercase mapping, not case folding (RFC 0001 1.1). **Gate passed** on the owner's standing instruction to push and open a draft PR at the first gate and carry on; the spec text is for review in that PR |
