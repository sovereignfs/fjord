# Fjord Web — 3 — Repository kinds

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [RFC 0001](../rfcs/0001-repository-kinds.md) until task 3a.1 moves it into [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); the `ssg` kind's detail is [Research 0001](../research/0001-ssg-kind.md). Where this file and either disagree, they are right. The order of work, across legs, is [workstream 0001](../workstreams/0001-repository-kinds.md).

**Status of the whole phase:** ⏳ in progress since 2026-11-02, when the owner accepted RFC 0001. The format (P9–P12) is done.

## What the phase promises, and what it does not

- **A repository opens as what it is for.** `fjord.json`'s `kind` (`drive`, `journal` or `ssg`) chooses the landing page: a file explorer, a timeline, a site's content editor. Every repository can still be opened as a drive, and one of a kind a client does not know *is* opened as a drive.
- **One format.** A journal's entries and a site's posts are Fjord Docs like any other. Editing, versions, sharing, comments and encryption are phases 1 and 2's, unchanged.
- **An encrypted journal reveals no more than an encrypted vault does** (spec §11.2): entries are not put in dated folders, and the timeline and tags of an encrypted journal are derived where it is decrypted, never committed and never on the server in plaintext.
- **Not in this phase:** Fjord building a site itself (3d.2 is an outline), Fjord publishing one (never; spec §12), importing an existing site whose content is not in one root vault (RFC 0001, open question 1), the new kinds in Fjord Mobile and `fjord-mcp` (they open them as drives).

## Prerequisites in fjord

| # | Task |
| --- | --- |
| P9 | Spec: repository kinds, `date`, and comparing tags |
| P10 | `fjord-core`: kinds, their rules and their scaffolds |
| P11 | CLI: `init --kind`, `verify` and journal entries |
| P12 | `fjord-wasm`: kinds and journal paths |

### P9 Spec: repository kinds, `date`, and comparing tags

**Status:** ✅ Done

**Design:** RFC 0001, The `kind` field, The rules of each kind, `date`, Tags, Diagnostics

Write RFC 0001's format change into `docs/specs/Fjord.spec.md`:

- §3: `kind` and the settings object named after it, the fallback to `drive` and the duty to keep both.
- §2: files outside any vault are allowed. The format already relies on this (a root `README.md`); it is said in words for a site's engine files.
- The one-vault rule for `journal` and `ssg`, and plaintext for `ssg`.
- §8.1: `date`, with its local offset and the reason for the exception.
- §8.1: tag comparison as a SHOULD.
- §11.2: a sentence on choosing paths in an encrypted vault.

Fixtures: `tests/fixtures/broken/<code>/` for each new code, and a conforming repository of each new kind.

**Accepts when:** the spec says all of it; every new fixture emits exactly its code and nothing else; the conforming fixtures, old and new, emit nothing; the RFC's status says it was implemented by P9.

- **Done as:** the spec's new §3.1 (kinds, the one-vault rule, plaintext `ssg`, the fallback), §2's sentence on files outside vaults, §8.1's `date` and tag comparison, §11.2's sentence on paths, and **Kind** in §1.3, with no format version change. One deliberate change from the RFC: tags compare by Unicode's **default lowercase mapping** after NFC, not by case folding, because that is what every client's standard library has (JavaScript has no case folding), so the CLI and the web agree byte for byte (RFC changelog 1.1). The codes are `E111`, `E112` and `W606`, as the RFC proposed. The fixtures (`broken/E111`, `E112`, `W606`, and conforming `journal/` and `ssg/`) landed with P10's code, so that every commit kept the fixture suite green.
### P10 `fjord-core`: kinds, their rules and their scaffolds

**Status:** ✅ Done

**Design:** RFC 0001, The CLI and `fjord-core`, Diagnostics

The manifest reads `kind` and its settings object and writes them back as they were, unknown values included. The new diagnostics go into `diagnostics.rs`, and the CLI README's tables follow them (`readme_diagnostics.rs` holds the two together). The scaffold-as-data of P6 gains a kind: one vault for a journal, plaintext or encrypted (`id` naming and a tar container when encrypted), and for `ssg` one plaintext vault plus the engine's files (Research 0001, *What both engines need*). A journal entry's path is computed from a `date` and an optional slug, in the writer's local time. All of it is in the pure subset.

**Accepts when:** round-tripping `fjord.json` with an unknown kind and an unknown settings object loses nothing (a property test, beside the frontmatter one); each kind's scaffold, written to disk, passes `verify`; the entry path is tested across a day boundary in UTC that is not one in local time; the pure subset builds for `wasm32-unknown-unknown`.

- **Done as:** in `fjord-core`, all in the pure subset:
  - `manifest::Kind`, `Engine`, `Manifest::kind` and `presented_kind`. Nothing was needed to preserve them, because the manifest is its raw map; the seeded property test `any_kind_and_its_settings_survive_a_rewrite` holds it.
  - The three codes in `diagnostics.rs`, checked in `verify.rs` (`check_kind`, against the vaults on disk; `W606` in `check_markdown`). A kind or `ssg` value of the wrong type is `E110`.
  - `scaffold::plan_kind_with`, with templates under `crates/fjord-core/templates/` (`README-journal.md`, `README-ssg.md`, `ssg/astro/`, `ssg/jekyll/`). A drive is `plan_with`'s bytes exactly, with no `kind` written. An encrypted journal has no recipients yet (`W602`), as `Private` does.
  - `journal::entry_path` and `slug`: an encrypted journal is filed flat as `YYYY-MM-DD-HHMM[-slug].md`, the name inside its container.
  - `scalar::is_entry_date` and `rfc3339_from_unix_at_offset`.
  - `tags::fold`, `same` and `is_under`. These were moved here from 3b.3, as the workstream asked, so every client compares tags alike.
  - Tests: `crates/fjord-core/tests/kinds.rs` writes and verifies each scaffold.
  - **Left for later:**
    - the engine templates are a starting point, and 3c.1's spike builds them;
    - `verify` walks everything outside the vaults, so a site with `node_modules/` installed may show path warnings locally (3c.1 decides whether `verify` should skip gitignored files outside vaults).
### P11 CLI: `init --kind`, `verify` and journal entries

**Status:** ✅ Done

**Design:** RFC 0001, The CLI and `fjord-core`

- `fjord init --kind drive|journal|ssg`, with `--engine astro|jekyll` for `ssg` and `--encrypt` for a journal. Interactive on a TTY, and a usage error under `--no-input` when something is missing.
- `verify` checks the kinds' rules, and `--json` reports the repository's kind under a name that does not clash with `ls --json`'s `kind` (P2 already uses that name for a file).
- In a journal, `fjord new` with no path makes an entry for now, at the path P10 computes.

**Accepts when:** `fjord init --kind <k> x && cd x && fjord verify` exits 0 for each kind; an `ssg` repository with an encrypted vault, and a journal with two vaults, each fail with their codes; the schema of `verify --json` (`schema/`) gains the field; the README documents all of it.

- **Done as:**
  - **`init`:** `--kind`, `--engine`, `--encrypt` (`cmd/init.rs`). With no `--kind` a repository is a drive, made exactly as before. A flag for another kind is refused (exit 2). On a terminal, a site's engine is asked for.
  - **`verify --json`:** a top-level `repositoryKind`, required in `schema/verify.schema.json`. The human output names a kind other than `drive` (`format version 1 · journal`), so the golden files did not change.
  - **`new`:** with no path, in a journal, it writes an entry dated now at the machine's offset (`--date` to choose). It uses `time`'s `local-offset` feature in the CLI only, and falls back to UTC with a note. A second entry in the same minute takes a number.
  - **Tests:** `crates/fjord-cli/tests/kinds.rs`.
### P12 `fjord-wasm`: kinds and journal paths

**Status:** ✅ Done

**Design:** RFC 0001, The CLI and `fjord-core`

Expose P10 to JavaScript: a repository's kind and settings from its manifest (through discovery, which the web already calls), the scaffold of each kind, and an entry's path from a `date`.

**Accepts when:** the module's JavaScript tests read every new fixture with the answers the CLI gives (`fixtures.test.mjs`); its size change is recorded here.

- **Done as:**
  - `describeRepositoryManifest` reports `kind` (the one to present), `declaredKind` and `ssgEngine`. The kind comes from `fjord.json`, which the web already reads with this function: `discover` takes only the vault manifests, so it was not the place.
  - New exports: `planKind`, `journalEntryPath`, `journalSlug`, `entryDateFromUnix`, `isEntryDate`, `foldTag`, `sameTag` and `tagIsUnder`.
  - `discovery.json` records each fixture's kind. `verify` is held to it in Rust, and the module in `fixtures.test.mjs`. `kinds.test.mjs` covers the rest, including that `foldTag` agrees with JavaScript's own `normalize` and `toLowerCase`.
  - **Size:** 1,385,572 bytes and 522,115 gzipped, from 1,321,125 and 499,067.
## 3a — Kinds in the web client

### 3a.1 Kind modules

**Status:** ✅ Done

**Design:** RFC 0001, The kind modules of Fjord Web

A module per kind, behind one interface: entry view, scaffold, content model, actions. A registry chooses the module from the repository's kind, and falls back to Drive for a kind it does not know. "Show files", which opens the drive view, is reachable from every kind. Move the RFC's design into `DESIGN.md` as a section of its own, and add the decision to its log.

**Accepts when:** a repository with no `kind`, with `drive`, and with a kind the client does not know, each opens on the drive view; a test registers a stand-in kind and its entry view is shown with nothing else changed; every new route is in `src/access/routes.ts`.

- **Done as:**
  - `src/kinds/`: `types.ts` (`KindModule`: `EntryView`, `contentModel`, `actions`), `registry.ts` (`kindFor`, `registerKind`) and `entry.tsx` (`entryFor`, used by `/` and `/repo/<connection>`).
  - The kind is the format module's `kind`, from `describeRepositoryManifest`, so `src/format/types.ts` gains `kind`, `declaredKind` and `ssgEngine`.
  - A kind the format does not define but a module registers (a newer kind, or a test's stand-in) is presented by that module. A defined kind the format presents as a drive (an `ssg` with an unknown engine) is a drive whatever is registered.
  - *Show files* is `?view=files` on the same page, so no route was added.
  - The design moved into `DESIGN.md` §8, "Repository kinds", with a decision-log row.
  - **Tested:** `registry.test.tsx`. **Not run here:** the e2e suite.
### 3a.2 Drive as a kind

**Status:** ✅ Done

**Design:** RFC 0001, The kind modules of Fjord Web; DESIGN §8

Today's vault list and folder browser become the `drive` module's entry view, with no change of behaviour.

**Accepts when:** the existing browse unit and e2e tests pass unchanged; nothing a person sees differs for an existing repository.

- **Done as:**
  - `src/kinds/drive.tsx`: the vault list, *Add a vault* and the top of the default vault, moved out of `RepositoryView` unchanged. `RepositoryView` now shows whatever entry view it is given, and the link between a kind and its files.
  - Committed with 3a.1, since the registry falls back to this module.
  - The browse, connection, access and format unit tests pass unchanged. The e2e suite was not run in this session.
### 3a.3 Choosing a kind

**Status:** ✅ Done

**Design:** RFC 0001; DESIGN §7 (setting up a repository, 1a.10)

When a repository that is not a Fjord repository is set up, offer a kind: drive (today's offer), journal (plaintext, or encrypted when the person has an identity, as 2d.1 does for vaults), or site (with an engine). The plan is `fjord-core`'s scaffold, through the module (P12), previewed before the one commit, as today. A repository's kind can later be changed from its settings, with the new kind's rules checked first.

**Accepts when:** each kind set up in the web client passes the real `fjord verify` (`FJORD_CLI`, as `cli.test.ts` does); changing a kind refuses a repository that breaks the new kind's rules and says why; an `ssg` repository is never offered an encrypted vault.

- **Done as:**
  - **In `fjord-core`:** `scaffold::plan_setup_kind`, which composes `plan_vault` for the one vault, so an encrypted journal is an encrypted vault added with the person's key, writable at once. Also `scaffold::with_kind` and `manifest::kind_rule`, exposed as `planSetupKind`, `withKind` and `kindRule`.
  - **In the web client:**
    - `browse/setup.ts`: `SetupChoice`; `assessSetup` previews every kind; `applySetup` takes a choice; `changeKind`.
    - `connections/http.ts`: `handleSetup` takes a kind, and refuses an encrypted site. `handleKind` serves the new `PUT /api/connections/[id]/kind`, which is in `routes.ts`.
    - `SetupOffer.tsx` chooses a kind; `kinds/screens/ChangeKind.tsx` changes one.
  - **Tested:**
    - `setup-kinds.cli.test.ts`: each kind set up from the web, and a drive changed to a journal, pass the real `fjord verify --strict`.
    - `setup.test.ts`: the previews, a site refused for its `package.json`, and a change refused for two vaults and for an encrypted site vault.
    - `http.test.ts`: who may call, and the request's shape.
  - **Different from the task as written:** an encrypted journal set up here takes this browser's key only. Adding more is *Add a vault*'s form, which is not repeated here.
## 3b — Journal

### 3b.1 Journal entries

**Status:** ✅ Done

**Design:** RFC 0001, Journals

"New entry" makes a note dated now in the writer's local time. In a plaintext journal it goes at the conventional path, and in an encrypted one at the vault's root. It opens in the note editor. The `date` can be changed from the properties panel (1b.5), and changing it never moves the file.

**Accepts when:** an entry made just after midnight local time is on that local day, whatever the UTC date; an entry in an encrypted journal is created with no dated directory; a moved entry keeps its place on the timeline.

- **Done as:**
  - **`fjord-core` and the module:** `doc::new_entry`, `doc::with_date` and `journal::entry_path`, exposed as `newEntry`, `withDate` and `journalEntryPath`.
  - **Plaintext journal:** `src/journal/entries.ts` (`createEntry`, `journalVault`) behind `POST /api/connections/[id]/files/entry`. It is sent the moment and the browser's offset; the server's module writes the `date`. A second entry in one minute takes a number.
  - **Encrypted journal:** `src/journal/seal.ts`. The page writes and encrypts the entry under its flat name inside the container, and sends it to the encrypted files' route with no title. The server names it by a new id.
  - **The page:** `src/journal/screens/NewEntry.tsx`, on the journal module's entry view (`src/kinds/journal.tsx`, now registered).
  - **Changing the date:** the header route takes a `date` (or `null`) as well as a `title`. `DocumentProperties` has a Date field, for every note, as spec §8.1 defines `date` for every Doc. Changing it rewrites the header and never the path.
  - **Tested:**
    - `entries.test.ts`: the local day across UTC's, and the numbering.
    - `seal.test.ts`: the encrypted entry is flat, and its date and title are only in the ciphertext.
    - `http.test.ts` and `access.test.ts`: who may call, and the shape of the request.
  - The timeline itself, and a moved entry keeping its place, are 3b.2's.
### 3b.2 Timeline

**Status:** ✅ Done

**Design:** RFC 0001, Journals

The journal's entry view: entries newest first, grouped by day, with their title and the start of their text, paged. The index is derived from `date`, falling back to the path and then `created` (and `W606` shown for a `date` that cannot be read). For a plaintext journal it is built on the server. For an encrypted journal it is built in the browser from entries decrypted there, kept in memory or in the browser only, never sent to the server.

**Accepts when:** a timeline of a few thousand entries pages without reading every blob at each view; a test of the encrypted journal reads every request the page sends and finds no date, title or tag of an entry; entries with a `date` and a path that disagree are placed by the `date`.

- **Done as:**
  - **`fjord-core`:** `journal::when` (the `date`, then the path, then `created`) and `journal::summary`, as the module's `journalEntry`.
  - **Plaintext journal:**
    - `src/journal/timeline.ts`: `summaries` reads only the entries that `journal_entry` does not hold by blob and path; `arrange` sorts newest first, groups by day, pages by 50 and filters.
    - `src/journal/index-store.ts` keeps `journal_entry`, a derived table in both dialects (migration 0016). Its rows go with a disconnected repository, and with a deleted person through it.
    - `screens/Timeline.tsx` reads the page, the tags and the days from the address.
  - **Encrypted journal:** `encrypted-timeline.ts` and `screens/EncryptedTimeline.tsx`. The browser fetches each entry's ciphertext by its identifier, decrypts it with its key (asking for the passphrase when the key is locked), and summarises it with the module. The result is kept in memory only.
  - **Tested:**
    - `timeline.test.ts`: on each database leg, the order, the date beating the path, and that a second and third page of 120 entries read no entry again.
    - `encrypted-timeline.test.ts`: the privacy test, which records every request and finds only GETs of identifiers, with no date, title or tag.
  - **Left out:** a timeline of a repository whose listing the host cuts short. The page says so and offers its files. The browser's index is not cached between visits; the privacy rule comes first (workstream, Risks).
### 3b.3 Tags

**Status:** ✅ Done

**Design:** RFC 0001, Tags

A tag index shared by every kind, built where the timeline index is and under the same rule for encrypted vaults. Comparison is `fjord-core`'s (`tags`, through the module's `sameTag` and `tagIsUnder`): case-insensitive after NFC by the lowercase mapping, with `/` as nesting (spec §8.1). In the journal: filter the timeline by one or more tags and a date range, a list of every tag with its count, and suggestions of existing tags while one is typed into an entry's `tags`.

**Accepts when:** `Work` and `work` are one tag and both spellings stay as they were written in the files; a filter on `project` includes `project/fjord`; the suggestions offer existing spellings first; the encrypted case is tested as in 3b.2.

- **Done as:**
  - **Comparison** is `fjord-core`'s (`tags::fold`, `same`, `is_under`) through the module's `foldTag`, `sameTag` and `tagIsUnder`, so the CLI and every client agree. It was written in leg 1.
  - **The index** is the timeline's (`journal/timeline.ts`, `tagCounts`, `arrange`). One tag is counted once per entry and shown as first written. A filter takes any number of tags and a range of days, and a parent matches the tags under it. It is the same code for a plaintext journal, on the server, and an encrypted one, in the browser.
  - **The page:**
    - the tag list and filter are `journal/screens/TagFilter.tsx`, with the choice in the address for a plaintext journal and in memory for an encrypted one;
    - editing is a Tags field in the properties panel, which writes the list as typed through the header route (`withTags`).
  - **Suggestions** are the journal's own tags, from the timeline's index (`journal/server.ts`), offered while the last word is typed and never a tag already there. An encrypted journal's would have to come from the browser's decrypted entries, which the file page does not hold, so it has none.
  - **Tested:**
    - `timeline.test.ts`: `Work` and `work` are one tag, a filter on `project` finds `project/fjord`, and both spellings are kept in the files;
    - `encrypted-timeline.test.ts`: the privacy rule;
    - `DocumentProperties.test.tsx`: the suggestions.
  - **Different from the task as written:** "a list of every tag with its count" is in the filter's panel, not a page of its own.
## 3c — SSG

### 3c.1 Site scaffold

**Status:** 📋 Planned

**Design:** RFC 0001, Sites; Research 0001, *What both engines need* and *Recommendation*

Opens with a spike that settles every **to confirm** of Research 0001 against the engines' current releases, recorded here. Then each engine's scaffold, from P10: Astro with `glob()` over `content/`, Jekyll with `collections_dir: content`, the manifests kept out of the built site, and, if the person chooses, the host's usual publishing workflow.

**Accepts when:** each scaffold builds with its engine's own tools on a clean machine (in CI or recorded here) and the built site contains neither manifest; each passes `fjord verify`.

### 3c.2 Content editor

**Status:** 📋 Planned

**Design:** RFC 0001, Sites; Research 0001

The `ssg` module's entry view: the site's posts, and for Astro its pages, with the fields of a fixed content model per engine (title, `date`, `tags`, draft, description). Paths follow the engine's rules (Jekyll's dated names). Drafts take the engine's own form. Editing is the document and note editors, unchanged.

**Accepts when:** a post written in Fjord builds with its engine and shows its fields (checked against a scaffold of 3c.1); a Jekyll post's file name follows its `date`; a tag with a space is refused for Jekyll.

### 3c.3 Build status

**Status:** 📋 Planned

**Design:** Research 0001, *Build status and preview*

The head commit's statuses, checks and deployments, read through the `Provider`, shown on the site's page: building, built (with the site's address when the host gives one), or failed (with the host's link). Nothing is configured in Fjord. A host that reports nothing shows nothing.

**Accepts when:** the provider contract covers reading statuses (`MemoryProvider` and the GitHub fixtures, re-recorded); the page shows each state from a recorded answer.

## 3d — Preview

### 3d.1 Previews through the host

**Status:** 📋 Planned

**Design:** Research 0001, *Build status and preview*, open question 4

"Preview" commits the working copy to a preview branch, not the default branch, waits for the host's status on that commit, and shows its link. The branch's lifetime (one per working copy or one per person, and when it is deleted) is decided at the start of this task and recorded here.

**Accepts when:** against a recorded host answer, the link appears for the preview commit and not the default branch's; the default branch is never written; a host that previews no branches is told plainly, not left waiting.

### 3d.2 A build in Fjord

**Status:** 🚧 Open (needs its own RFC and a security review)

**Design:** Research 0001, *Build status and preview*, point 4

An outline only. A sandboxed build of the site, served from another origin, behind the `ssg` module's actions. Not started before its RFC is accepted.
