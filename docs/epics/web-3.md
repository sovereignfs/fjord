# Fjord Web — 3 — Repository kinds

The detail of the tasks in this part of [`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md): what each one is, how it is known to be done, and how it was done. The design is [RFC 0001](../rfcs/0001-repository-kinds.md) until task 3a.1 moves it into [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md); the `ssg` kind's detail is [Research 0001](../research/0001-ssg-kind.md). Where this file and either disagree, they are right. The order of work, across legs, is [workstream 0001](../workstreams/0001-repository-kinds.md).

**Status of the whole phase:** ✅ built 2026-11-02 to 2026-11-03, except 3d.2 (a build in Fjord), which is an outline that needs its own RFC and a security review. The order of the work was [workstream 0001](../workstreams/0001-repository-kinds.md), and every task below says how it was done and what was left out.

**A second pass** ([RFC 0002](../rfcs/0002-kinds-second-pass.md), [workstream 0002](../workstreams/0002-kinds-second-pass.md)) is planned at the [end of this file](#kinds-second-pass-rfc-0002): P13–P17, then 3e–3h.

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
  - **Tested:** `registry.test.tsx`, and in a browser by `e2e/kinds.open.spec.ts` (every kind can be shown as files and back). The browser suite passes in full (162 tests).
### 3a.2 Drive as a kind

**Status:** ✅ Done

**Design:** RFC 0001, The kind modules of Fjord Web; DESIGN §8

Today's vault list and folder browser become the `drive` module's entry view, with no change of behaviour.

**Accepts when:** the existing browse unit and e2e tests pass unchanged; nothing a person sees differs for an existing repository.

- **Done as:**
  - `src/kinds/drive.tsx`: the vault list, *Add a vault* and the top of the default vault, moved out of `RepositoryView` unchanged. `RepositoryView` now shows whatever entry view it is given, and the link between a kind and its files.
  - Committed with 3a.1, since the registry falls back to this module.
  - The browse, connection, access and format unit tests pass unchanged, and so does the whole browser suite (`pnpm e2e`, 162 tests), which opens existing repositories as drives.
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
  - The timeline itself, and a moved entry keeping its place, are 3b.2's. In a browser (`e2e/kinds.open.spec.ts`): a new entry is made in the dated folder of the browser's own day, with a `date` that keeps its offset.
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
  - **A bug the browser showed and the unit tests did not:** a site's post, which has no `# heading`, was listed under its file name, because the summary took `fjord-core`'s `implied_title` (heading, then name) and never looked at the header's own `title` first (spec §8.2). Fixed in `journal::summary` with a test that has no heading, and `journal_entry` rows now carry a version (`SUMMARY_VERSION`), so rows made by another version of the summary are read again and not believed.
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

**Status:** ✅ Done

**Design:** RFC 0001, Sites; Research 0001, *What both engines need* and *Recommendation*

Opens with a spike that settles every **to confirm** of Research 0001 against the engines' current releases, recorded here. Then each engine's scaffold, from P10: Astro with `glob()` over `content/`, Jekyll with `collections_dir: content`, the manifests kept out of the built site, and, if the person chooses, the host's usual publishing workflow.

**Accepts when:** each scaffold builds with its engine's own tools on a clean machine (in CI or recorded here) and the built site contains neither manifest; each passes `fjord verify`.

- **Done as:**
  - **The spike** is written up in Research 0001 ("Confirmed by building"). Every **to confirm** was settled by building both scaffolds, and none changes the approach: both engines read their content from a root vault. The leg 4 condition in the workstream ("Do not proceed if an engine cannot read its content from a root vault") does not hold.
  - **One defect found and fixed:** Jekyll posts had no layout, so `_config.yml` has `defaults` giving posts the `post` layout. `a_jekyll_site_keeps_the_manifests_out_and_lays_its_posts_out` (`kinds.rs`) holds that and the `exclude` lines in place. The exclusion was seen to be needed: without it Jekyll copies `fjord.json`, the vault manifest and the README into `_site/`.
  - **The check is a job of its own**, not in the Rust matrix: `scripts/check-site-scaffolds.sh` builds each scaffold with a draft and an offset-dated post and checks the output, and `.github/workflows/sites-ci.yml` runs it when a template or `scaffold.rs` changes, and weekly. Run on 2026-11-02 here: Astro 5.18.2 and Jekyll 4.4.1, both pass. **Not run: the workflow on GitHub's runners**, which first runs when this is pushed.
  - **Known and left to the site's owner:** the address of a Jekyll post uses the build machine's day. Fjord sets no `timezone`.
  - **Not done:** the host's usual publishing workflow (the optional part of the task). Publishing is the host's (spec §12), and a workflow file for a host this document has not tested is not something to write blind.
### 3c.2 Content editor

**Status:** ✅ Done

**Design:** RFC 0001, Sites; Research 0001

The `ssg` module's entry view: the site's posts, and for Astro its pages, with the fields of a fixed content model per engine (title, `date`, `tags`, draft, description). Paths follow the engine's rules (Jekyll's dated names). Drafts take the engine's own form. Editing is the document and note editors, unchanged.

**Accepts when:** a post written in Fjord builds with its engine and shows its fields (checked against a scaffold of 3c.1); a Jekyll post's file name follows its `date`; a tag with a space is refused for Jekyll.

- **Done as:**
  - **`fjord-core`:** `site::post_path`, `new_post` and `tag_problem` (also in the module and the CLI). Astro's `posts/<slug>.md` takes a `draft` field. Jekyll's `_posts/YYYY-MM-DD-<slug>.md` takes its day from the `date` as the writer wrote it, and a draft is `_drafts/<slug>.md`. A Jekyll tag with whitespace is refused.
  - **The CLI:** `fjord new` with no path in a site makes a post, with `--draft`. `scripts/check-site-scaffolds.sh` makes its posts that way and builds them with each engine's own tools. Both build, with the draft left out and the offset-dated post present (Astro 5.18.2, Jekyll 4.4.1).
  - **The web:**
    - `src/site/posts.ts` (`createPost`, `siteVault`) behind `POST /api/connections/[id]/files/post`, in `routes.ts`;
    - `src/kinds/ssg.tsx`, the site's module, registered; `src/site/screens/NewPost.tsx`;
    - the posts are the journal's timeline code (`Timeline`), with a Draft badge, since a post has a `date`, tags and a title like an entry.
  - **The tag rule** is on the header route: `tagProblem` reads the repository's engine and refuses with the engine's words (`bad_tag`), for any note of that site.
  - **Tested:**
    - `e2e/kinds.open.spec.ts`, in a browser: a repository that is not a Fjord repository set up as an Astro site, a draft post made, the host's build shown with the site's address, and on a Jekyll site a tag with a space refused with the engine's reason;
    - `posts.test.ts`: both engines, the writer's day, the numbering, and the vault checks;
    - `http.test.ts` and `access.test.ts`: who may call, and the refused tag;
    - `setup-kinds.cli.test.ts`: a post made in the browser in a site set up in the browser passes the real `fjord verify --strict`.
  - **Different from the task as written:**
    - *Pages* are not edited. The scaffold has no pages collection: an Astro site's pages are its code (`src/pages`), and a Jekyll site's pages are outside the vault (Research 0001). Both are in the files view.
    - *Description* is not a field of the new-post form or of the properties panel; a post keeps one if it has one.
  - **Left out:**
    - changing a draft into a published post. In Astro that is editing `draft`; in Jekyll it is moving the file to `_posts/` under a dated name. Neither is built;
    - a post's own date does not rename a Jekyll post, which keeps the date its name had (Jekyll's `date` key overrides the name's, Research 0001).
### 3c.3 Build status

**Status:** ✅ Done

**Design:** Research 0001, *Build status and preview*

The head commit's statuses, checks and deployments, read through the `Provider`, shown on the site's page: building, built (with the site's address when the host gives one), or failed (with the host's link). Nothing is configured in Fjord. A host that reports nothing shows nothing.

**Accepts when:** the provider contract covers reading statuses (`MemoryProvider` and the GitHub fixtures, re-recorded); the page shows each state from a recorded answer.

- **Done as:**
  - **The contract:** `Provider.getBuildStatus(ref, commit)` returns `{ commit, state: none | pending | success | failure, checks, siteUrl? }`. `MemoryProvider.reportBuild` and the GitHub fake (`fake.reportBuild`) hold what a host's integrations posted. Both are run through `providerContract` ("a commit's build"): nothing reported is `none`; a failure is not hidden by something still running; the site's address comes from a successful deployment; a later commit has its own; an unknown commit is `not_found`.
  - **GitHub** (`github/provider.ts`): check runs, commit statuses, deployments, and each deployment's newest status. A replaced (`inactive`) deployment is left out. GitHub's 422 for an unknown commit is `not_found`. Only `http(s)` addresses are kept, as the host gave them.
  - **Re-recorded:** `node scripts/record-github-fixtures.mjs --additions` added GitHub's real answers for the fixture's commit, leaving the rest as recorded. They show that the combined status is `pending` with no status for a commit nothing posted to, so the provider reads the statuses and not that state; that commit has 16 check runs and no deployment.
  - **The page:** `site/screens/BuildStatus.tsx` reads the head commit through the connection's own provider, and `BuildStatusView.tsx` says building, built or failed. It is on the site module (`kinds/ssg.tsx`). A token that may not read these says so. Any other failure to read leaves the page as it was.
  - **Tested:** the contract on both providers; `github.test.ts` (conclusions, replaced deployments, unsafe links, a forbidden token, the requests made); the recorded test; `BuildStatusView.test.tsx` for each state.
  - **Different from the task as written:** each state is tested from the view and the provider's answers separately, not as one page from one recorded answer. The page needs the connection, session and database to render, which a unit test does not stand up. **Not run:** a real GitHub deployment's `environment_url` (this repository has none), so the siteUrl path is held to the fake and the documented shape only.
## 3d — Preview

### 3d.1 Previews through the host

**Status:** ✅ Done

**Design:** Research 0001, *Build status and preview*, open question 4

"Preview" commits the working copy to a preview branch, not the default branch, waits for the host's status on that commit, and shows its link. The branch's lifetime (one per working copy or one per person, and when it is deleted) is decided at the start of this task and recorded here.

**Accepts when:** against a recorded host answer, the link appears for the preview commit and not the default branch's; the default branch is never written; a host that previews no branches is told plainly, not left waiting.

- **Done as:**
  - **Decided at the start, as the task said: the branch's lifetime.** One branch per preview, `fjord/preview/<hash of the account>-<UTC time>`, cut from the default branch's head with one commit of the person's drafts, kept until the person stops it (which deletes the branch), at most three at a time. Rejected: one reused branch per person (it would have to be reset to the default branch each time, which is a force); a timer that deletes old branches (a repository's history is not Fjord's to prune unasked). The hash keeps the name from saying who the person is in a repository others read.
  - **`Provider`:** `createBranch` (`branch_exists` for a name that is taken, never a reset), `deleteBranch` (the default branch refused as `invalid_request`, by the provider itself, so a caller cannot name it by mistake) and `listBranches(prefix)`, in `MemoryProvider`, the GitHub provider and the GitHub fake, and in `providerContract`. GitHub answers a missing branch and a taken name with a 422 each, mapped to `not_found` and `branch_exists`.
  - **`src/site/preview.ts`:** `candidates` (the person's own plaintext drafts in the site's vault whose base is still the file at the head; others are named as left out), `startPreview`, `previewsOf`, `stopPreview` and the pure `outcomeOf`. A preview that is refused after its branch was made deletes the branch.
  - **The link is the preview commit's.** `previewsOf` reads `getBuildStatus` of the preview's own commit. The test reports a built default branch with its own address first and finds the preview still waiting until the host reports the preview's commit.
  - **A host that previews no branches** has `unsupported` after three minutes of nothing reported (`WAIT_MS`), with words naming what to look at (hosts that build every branch; GitHub Pages does not), and the preview still there to stop.
  - **HTTP:** `src/site/preview-http.ts`, `GET`/`POST`/`DELETE` at `/api/connections/[id]/previews`, in `routes.ts` (read; `save_version`). Nothing about the branch, paths or text is taken from a request to start one. The Origin check and the "only your own branch" rule were each seen to fail their tests with the rule switched off.
  - **The page:** `site/screens/PreviewPanel.tsx` (polls every five seconds while any preview is waiting or building) and `PreviewRows.tsx` (each state, from a recorded answer), on the site module.
  - **Tested:** the contract on both providers; GitHub's real answer for a branch listing, recorded (`record-github-fixtures.mjs --additions`); `preview.test.ts` on each database leg; `preview-http.test.ts`; `PreviewRows.test.tsx`; and in a browser, `e2e/kinds.open.spec.ts`: the flow end to end against a git-backed fake, with the default branch's head and file unchanged and the default branch's own build address not shown.
  - **Found by the browser test:** the fake GitHub listed branches by path segments (as `git for-each-ref` does), where GitHub matches the prefix as a string, so a person's previews were not found. Fixed, with a contract case.
  - **No account or token at the host itself was needed** (the workstream's "Do not proceed if"): the address is what the host posted to the repository, read with the connection's own token.
  - **Not done:** a real host's preview (none is connected to this repository); creating or deleting a branch on real GitHub, which is held to the fake's contract and the documented API only; previewing an encrypted vault's drafts (a site is never encrypted); a Jekyll site's preview of a *new* post, since a draft is of a file that exists.
### 3d.2 A build in Fjord

**Status:** 🚧 Open (needs its own RFC and a security review)

**Design:** Research 0001, *Build status and preview*, point 4

An outline only. A sandboxed build of the site, served from another origin, behind the `ssg` module's actions. Not started before its RFC is accepted.

## Kinds, second pass (RFC 0002)

Planned on 2026-11-03. [RFC 0002](../rfcs/0002-kinds-second-pass.md) is the design, and the order of work, leg by leg, is [workstream 0002](../workstreams/0002-kinds-second-pass.md). The spec text was written with the RFC, at the owner's request, so the prerequisites bring the fixtures and the code to it rather than change it. **The CLI's tasks come first:** every web task needs the format module to agree with them.

**What this part promises:** one kind of Doc, whose editor is the repository kind's choice; addresses with no real path in them; a journal encrypted unless asked otherwise; a drive's Doc publishable as a page; vaults at any depth; and `fjord init --adopt` for a directory that already has files. **Not in it:** rendering `.html` files from a repository, a CMS for sites beyond editing the vault's files, readable slugs, nested vaults.

| # | Task |
| --- | --- |
| P13 | Spec and fixtures: one kind of Doc, vaults at any depth, adopting into a checkout |
| P14 | `fjord-core`: `FileKind::Doc`, vaults at depth, the adoption plan |
| P15 | CLI: no documents, and journals encrypted by default |
| P16 | CLI: `init --adopt` |
| P17 | `fjord-wasm`: one kind of Doc, vaults at depth, the adoption plan |
| 3e.1 | One address and one editor per kind for a Doc |
| 3e.2 | Handles: `/f/<handle>` in place of paths |
| 3e.3 | Share any drive Doc |
| 3f.1 | The journal's writing view |
| 3f.2 | New journals encrypted by default |
| 3g.1 | A site's vault below the root |
| 3g.2 | Source and rich modes, and the frontmatter form |
| 3h.1 | Publish a Doc as a page |
| 3h.2 | Publish from an encrypted vault |

### P13 Spec and fixtures: one kind of Doc, vaults at any depth, adopting into a checkout

**Status:** ✅ Done

**Design:** RFC 0002, One kind of Doc, Vaults at any depth, Adopting existing files

The spec already says it (§1.3, §2.3, §3, §3.1, §6.6, §8.4, §12, as of 2026-11-03). This task checks that text against what P14 finds while building it, corrects it where the code shows it wrong, and adds the fixtures: `tests/fixtures/depth/` (a conforming Astro site whose vault is `src/content`), with `broken/E207/` (a vault inside a vault) still emitting exactly its code, and the conforming fixtures' `.fj.md` files left as they are, now ordinary Docs.

**Accepts when:** `depth/` emits nothing and `broken/E207/` still emits exactly `E207`; the conforming fixtures, old and new, emit nothing; RFC 0002's status says the spec was implemented by P13 and P14.

- **Done as:** the spec text needed two corrections once the code was written: the rule against a vault in a gitignored folder is gone (`verify` walks every folder, and `.gitignore` is git's), and the "no new code" outcome: a vault inside another is the existing **`E207`**, so RFC 0002's proposed `E113` was never needed. New fixture `tests/fixtures/depth/` (an Astro site whose vault is `src/content`), its entry in `discovery.json`, and `tests/fixtures/README.md`. `broken/E207/` is unchanged and still emits exactly its code.
- **Not here:** the CLI README's diagnostics table (nothing changed in it); fixtures for adoption, which P16 builds from a real directory.

### P14 `fjord-core`: `FileKind::Doc`, vaults at depth, the adoption plan

**Status:** ✅ Done (the adoption plan with P16)

**Design:** RFC 0002, One kind of Doc, Vaults at any depth, The CLI and `fjord-core`

- `listing.rs`'s `FileKind::Document` and `FileKind::Note` become `FileKind::Doc`; the `.fj.md` cases in `naming.rs` (`free_name`) and `merge.rs` go.
- Discovery, from the disk and from a listing, finds `fjord.vault.json` at any depth, never under `.fjord/` or `.git/`. A vault inside another is the existing `E207` (no new code). The path checks of `fjord.json`'s `vaults` accept `/` and still refuse `..`.
- Every place that assumes a vault is a root directory is found and fixed: the checkout's record, `rekey`, `export` and `import`, `vault add`'s planner.
- An adoption plan beside `scaffold::plan_setup`: given a listing and the chosen directories, the files to write and the lines to append, writing over nothing; for a site, the engine detected (`astro.config.*` → `src/content`, `_config.yml` → `_posts`); for `--encrypt-existing`, the vault encrypted and its checkout record.

**Accepts when:** the fixtures of P13 pass; a test of discovery: a vault anywhere is found, and any vault under another is `E207`; the adoption plan, applied to a directory, leaves every existing file byte for byte; the pure subset still builds for `wasm32-unknown-unknown`.

- **Done as:**
  - **`listing.rs`:** `FileKind::Document` and `Note` are `Doc`; `vault_manifest_at` accepts any depth (only the root is refused); `locate_vaults` takes the shallowest vault of each branch and reports a vault inside another, and a root manifest, as `nested` (`E207`); `Discovery::vault_containing` matches at any depth.
  - **`vault.rs`:** `discover` walks the tree (not into a vault, `.git`, the root `.fjord/` or a symlink) and asks `locate_vaults`; `containing` finds the shallowest vault above a path.
  - **`doc.rs`, `merge.rs`:** `is_document_name`, `DOCUMENT_SUFFIX` and the `.fj.md` special cases are removed. `plan.fj.md`'s title is `plan.fj`, its conflict copy `plan.fj.conflict-…md`.
  - **Checked and unchanged:** the checkout record is named by a digest of the vault's path, so `src/content` works; `rekey`, `export`, `import`, `grep`, `ls` and `new` join `vault.directory` as a string. Tests in `listing.rs`, `fixtures.rs` (a vault inside a vault at depth, a root manifest) and the existing suites.
- **The adoption plan** is `adopt::plan_adopt` (see P16). The pure subset builds for `wasm32-unknown-unknown` (`cargo check -p fjord-core --no-default-features --target wasm32-unknown-unknown`).
- **Not here:** `verify` still walks gitignored folders such as `node_modules/`.

### P15 CLI: no documents, and journals encrypted by default

**Status:** ✅ Done

**Design:** RFC 0002, One kind of Doc, Journals

- `fjord new --document` goes; `ls --json` drops `docKind`, and a Fjord Doc is `"kind": "doc"` as before.
- `fjord init --kind journal` encrypts its vault; `--no-encrypt` makes it plaintext (it was a drive's only); `--encrypt` goes.
- The README's sections for `init`, `new` and `ls` say so (`tests/readme_commands.rs`), and the CHANGELOG says it is breaking.

**Accepts when:** `fjord init --kind journal x && cd x && fjord verify` reports only `W602` (no recipients yet), and with `--no-encrypt` nothing; `fjord new --document` is a usage error; a `.fj.md` file is listed as a Doc like any other.

- **Done as:** `new --document` and `ls --json`'s `docKind` went with P14 (they could not build without it). `init --kind journal` encrypts by default (`cmd/init.rs`: `encrypt = !args.no_encrypt` for both kinds); `--encrypt` is removed, `--no-encrypt` is refused for a site only, and the terminal question defaults to yes. The README's `init`, `new` and `ls` sections and the CHANGELOG (marked **breaking**) say so; tests in `tests/kinds.rs` (a journal needs `--no-encrypt` to be plaintext; each flag for another kind is a usage error), `everyday.rs` (one kind of Doc; `--document` exits 2) and `id_naming.rs`.
- **Not here:** `fjord new` in an encrypted journal without an identity (it refuses as it does in any encrypted vault).

### P16 CLI: `init --adopt`

**Status:** ✅ Done

**Design:** RFC 0002, Adopting existing files

- `fjord init --adopt [--kind <kind>] [--vault <dir>]… [--engine <engine>]`, interactive on a terminal and scriptable with `--no-input`, with P14's plan.
- In a git repository: no `git init`, and a commit of only the files it wrote. Elsewhere: `git init` as today. `--no-git` as today.
- A journal with existing files needs `--no-encrypt` or `--encrypt-existing`; with `--no-input` and neither, exit `2`. `--encrypt-existing` warns about history (§6.6, §11.4) before writing anything, and leaves a checkout that `fjord key add` and `fjord encrypt <vault>` end.
- Opens with a spike on a real Astro starter and a real Jekyll site: does either engine complain about, or publish, `fjord.vault.json` in its content folder (RFC 0002, open question 1)?

**Accepts when:** adopting a directory with files and git history leaves every file byte for byte and the person's uncommitted changes uncommitted; `fjord verify` passes afterwards for each kind; an adopted Astro and Jekyll site still build; `--encrypt-existing` refuses every commit until the checkout ends, and ending it leaves no plaintext on disk or in the index; an existing `fjord.json` is refused.

- **Done as:**
  - **`fjord-core/src/adopt.rs`** (pure, in the wasm subset): `plan_adopt` for a drive, a journal or a site over the directories chosen. Every file of its plan is new but `.gitattributes` and `.gitignore`, which only gain lines (`FileChange::Append`, the original text first); it refuses a `fjord.json`, a vault inside another, a duplicate, a name that breaks §5 or is hidden, a file or a vault manifest that is in the way, and an encrypted site. `detect_site` reads `astro.config.*` and `_config.yml|yaml|toml` at the root. `PlannedVault::holds_files` is what tells a caller a checkout is needed.
  - **`fjord-cli/src/cmd/adopt.rs`**: the flags (`--adopt`, `--vault`, `--encrypt-existing`), the walk of what is there, the writes (`create_new` for a new file), and git: no `git init` in a repository, `git add` and `git commit -- <paths>` of only the written files, so staged and unstaged work is untouched. `--encrypt-existing` calls `checkout::begin_adopted` (a complete record with no entries) *before* writing the manifest, makes no commit, and prints the history warning. A refusal writes nothing.
  - **Tested** in `tests/adopt.rs` over real directories: byte for byte untouched but `.gitattributes`; one commit holding only Fjord's files while an unstaged edit and an untracked file stay as they were; a non-repository; vaults at depth; Astro and Jekyll found; a journal that must choose; the checkout end to end (`sync` refuses, `key add`, `encrypt` leaves no plaintext on disk and the history still holds it); refusals write nothing. Both of the commit-only-ours and record-the-checkout rules were seen to fail a test with them switched off.
- **Different from the RFC:** a journal over existing notes with neither flag is a usage error even on a terminal (the RFC had it ask); and `--vault` is required to adopt more than the default, with no terminal choice among the root's directories. Both are small to add later.
- **Not here:** the Astro and Jekyll *builds* after adoption (the spike): a `fjord.vault.json` in `src/content` or `_posts` could confuse an engine, and `scripts/check-site-scaffolds.sh` is where that would be tried; `node_modules/` is walked as any directory is.

### P17 `fjord-wasm`: one kind of Doc, vaults at depth, the adoption plan

**Status:** ✅ Done

**Design:** RFC 0002, The CLI and `fjord-core`

The module follows P14: a file is a Doc or not, vaults are discovered at any depth, and the web's setup (1a.10, 3a.3) can plan an adoption with existing directories as vaults.

**Accepts when:** the module's fixture tests agree with the CLI's `verify` on every fixture, the new ones included.

- **Done as:** `FileKind::Doc` is `"doc"` in `discover`; `impliedTitle` strips only `.md`; `planAdopt(options, existing, nowMs, random)` and `detectSite(existing)` (`src/api.rs`, `src/lib.rs`) wrap `adopt::plan_adopt` and `detect_site`, with a finding as data and a malformed call as an exception, and `16 × (1 + vaults)` random bytes for the identifiers. `tests/js/adopt.test.mjs` holds them (any depth, a site, appended lines only, findings, purity, detection). The web's `src/format/` types and wrapper (`AdoptOptions`, `AdoptResult`, `planAdopt`, `detectSite`) follow. The module's JavaScript suite (192 tests) and Rust tests pass; the pure subset builds for `wasm32-unknown-unknown`.
- **Not here:** a web page that calls `planAdopt` (it comes with 3g.1).

### 3e.1 One address and one editor per kind for a Doc

**Status:** ✅ Done (removing promotion on first edit was finished in 3e.3)

**Design:** RFC 0002, One kind of Doc, Addresses

Every Doc opens at `/d/<id>`, in the editor its repository's kind chooses (drive: the document editor; journal: the note editor in the journal's view; site: the content editor; unknown: as drive). `/n/<id>` answers a 308 to `/d/<id>`. The document and note distinction goes from the browser's table, creating (`files/create.ts`), renaming (`extension_changed`), restoring (`files/restore.ts`) and the messages. A file with no header is **no longer promoted on its first edit** (reversing 1b.5's promotion): it is edited as it is.

**Accepts when:** a `.md` and a `.fj.md` in a drive open in the same editor at `/d/<id>`; an old `/n/<id>` link lands on `/d/<id>`; editing a file with no header leaves it with none; every route is in `src/access/routes.ts`.

- **Done as:**
  - **The model:** the module reports one `doc` kind; `KindModule.editor` (`"document"` for a drive, `"note"` for a journal and a site) is what `RepositoryScreen` hands `FolderView` and `NoteView`, which picks the editor and gives comments to the document editor's Docs. `IdPage` is `/d/<id>` only; `app/n/` is gone and `proxy.ts` sends `/n/`, `/note/` and `/doc/` to `/d/<id>` (a 308, no token).
  - **Creation is one thing** (`files/create.ts`, `create-encrypted.ts`, `keys/files.ts`, `messages.ts`, `http.ts`, `client.ts`, `NewFile.tsx`): *New document*, a title optional, always `.md`, always with an `id` (`newDocument`), the date and time naming and titling an untitled one. The request has no `kind`.
  - **Sharing and the index:** the policy's target is `document | folder`; `not_a_document` is gone from the shares' and links' replies; `DocIndex` rows and `Found` carry no kind (the column says `doc`, older rows are read as `doc`); `deletion.kind` is `doc | other`. Renaming, restoring and moving keep a file's **extension** (`suffix()`, no `.fj.md` case).
  - **Tested:** the whole unit suite (2491 tests), against `FJORD_CLI`: what the web makes verifies with the real `fjord`, and the encrypted files open with the real `age`.
- **Not here:**
  - **Promotion on first edit is still there** (a file with no header is given `id`, `title` and `created` when first edited, 1b.5). The decision is to take it away and add an `id` only when sharing, publishing or commenting asks, after asking; that is one change with 3e.3's share step, so it is made there.
  - **The e2e specs** (`e2e/repositories.open.spec.ts`) were edited for the new labels, messages and URLs (New document, no `kind`, `.md` names, the numbered `Q4 plan 2.md`) but **not run** in this session: they need a built app and Chromium.

### 3e.2 Handles: `/f/<handle>` in place of paths

**Status:** ✅ Done

**Design:** RFC 0002, Addresses

A `file_handle` table (both dialects) maps a connection and a path to a random handle, made when a link to that path is first drawn. Folder lists link to `/d/<id>` where the index knows an `id` and to `/f/<handle>` otherwise. Fjord's move and rename update the handle with `doc_index`. A handle whose path is gone says "moved or gone". `/repo/<connection>/<path>` redirects once to its handle. Nothing is committed.

**Accepts when:** no page's address has a file or folder name in it; a handle survives a move made in Fjord; a file moved outside Fjord gives "moved or gone" at its old handle and never another file; another account's handle is a 404; the data-layer tests pass on all three database legs.

- **Done as:**
  - **The store:** `file_handle` (migration `0017_add_file_handle`, both dialects): connection, path, a 16-character base32 handle (80 random bits, unique), `created_at`. `src/browse/handles.ts` (`FileHandles`: `forPath` gets or makes one and survives a race, `resolve`, `move` carries a path's handle and everything under a folder to the new path, escaping `LIKE`). Derived, never committed.
  - **The addresses:** `/f/[handle]` (`app/f/[handle]/page.tsx`, `owner("read")` in `routes.ts`): the handle's repository must be the account's, else 404; `RepositoryScreen` takes `via` (`handle` or `id`). A path reached as `/repo/<connection>/<path>` is checked against the repository and **sent on** to `/d/<id>` (a Doc whose index row is current) or `/f/<handle>`; a path that is not there is a 404, and a handle is only made for a path that is, so it cannot be filled with guesses. A Doc found at a handle is sent on to `/d/<id>`. A handle whose path has nothing now says **Moved or gone**.
  - **Following Fjord's own moves:** `files/server.ts` calls `FileHandles.move(connection, target, destination)` beside the id index's. A disconnected repository's handles are deleted with it (`ConnectionService.remove`), and a Sovereign account deletion removes them through it.
  - **Tested** over the real databases (`handles.test.ts`: stable, per connection, nothing of the path in it, not a handle for anything that is not one, a file and a folder with what is inside it follow a move, a neighbour sharing a name prefix and LIKE characters do not); `connections/service.test.ts`; `sovereign/people.test.ts`.
- **Not here:**
  - **Links still draw `/repo/<connection>/<path>`**: each click is one redirect to the address that shows no path, which is what the address bar then shows. Drawing `/f/` and `/d/` directly, to save the hop, is an optimisation left.
  - **The e2e specs** still expect `/repo/…` addresses in `toHaveURL`; they were not run, and need updating when they are.

### 3e.3 Share any drive Doc

**Status:** ✅ Done

**Design:** RFC 0002, Sharing any drive Doc, Addresses

The `not_a_document` refusals go: any Doc in a drive can be shared with accounts or by link, and commented on. Sharing (or commenting on) a `.md` without an `id` asks first, then adds one through the module (the header a first edit used to give, 1b.5), and the page moves to `/d/<id>`; in a site, the question warns about the engine's `id`.

**Accepts when:** a `.md` that was a note can be shared; sharing one without an `id` writes only the header, after the person agreed, and its old handle redirects; a share made before still opens.

- **Done as:**
  - **Any plaintext Doc can be shared** since 3e.1 (the `not_a_document` refusals are gone); this task is the step for a file that has no `id`.
  - **`src/files/identify.ts`** (`identifyFile`): one commit that adds the `id` through `fjord-core`'s `promoteDocument` (a header that has none is given `id`, `title`, `created`; one that has keys keeps them, in their order), on the version the person looked at (`changed` otherwise), retried once on a moved head, never forced. A file that already has an `id` answers with it and commits nothing. A header that cannot be read, or CRLF or a byte-order mark that a new header would disturb, is `cannot_identify` and untouched. HTTP: `POST /api/connections/<id>/files/identify` (`handleIdentify`, `owner("edit")`; 401/403/405/404/400/409/422/502, each with its own code); access: the connection must be the caller's and the vault a plaintext one this version writes.
  - **The page:** `IdentifyAndShare` replaces the sharing controls on a Doc with no `id`: it says what will be written, asks, commits, and goes to `/d/<id>` where the sharing panel is. With unsaved changes it asks for a version first.
  - **No promotion on edit** (reversing 1b.5): `NoteView` no longer gives a file a header when it is first edited; a file with no header is edited as it is, and the properties panel says it has none and when one is added.
  - **Tested:** `identify.test.ts` against real git (one commit, the author, only a header added in front of the body, keys kept in order, already identified, changed/gone/not-Markdown, CRLF/BOM/broken left alone, a head that moved); `http.test.ts` (who may, from where, the body, each refusal's status and code); `access.test.ts` (another's connection is not found and nothing is read, each vault refusal); `client.test.ts`. The "changed since you looked" guard was seen to fail its test with it off.
- **Not here:** the handle of the file is not redirected to `/d/<id>` by this step itself; the next visit by path or handle is (3e.2). A file edited with unsaved changes must save a version first rather than have the identifier merged into the draft.

### 3f.1 The journal's writing view

**Status:** ✅ Done

**Design:** RFC 0002, Journals

Opening a journal offers today's entry, or a new one, in the note editor with the date and tags and nothing else on screen; the timeline is one step away. Any `.md` in the journal's vault is an entry, dated by `date`, else its path, else its first commit, so an adopted journal of plain daily notes has a timeline.

**Accepts when:** a new entry can be typed into within one action of opening the journal; a vault of `.md` files with no frontmatter shows on the timeline by their paths' dates; nothing is written to a file that was only opened.

- **Done as:**
  - **One action:** *New entry* makes the entry at once, dated now in the browser's own time, and opens it (`journal/screens/NewEntry.tsx`; plaintext on the server, encrypted in the browser as before). It has no title field: the title and the date are the properties panel's. Opening the journal writes nothing.
  - **A writing view:** `KindModule.writingView` (true for a journal). In it a file's page shows the editor and the properties and drops the kind and size line and the address by id; sharing, rename, move and delete are one step away under **More** (`data-testid="more"`). The editor is the byte-faithful Markdown one (`KindModule.editor`).
  - **Any `.md` is an entry** since 3e.1, because the timeline lists every Doc of the vault; one with no `date` is placed by the day its path is filed under (`journal::when`), else by `created`.
- **Not here:** dating an entry by its **first commit** (RFC 0002 named it): the timeline has no git history to read, so an entry with neither a `date`, a dated path nor `created` is listed without a day. The e2e spec's journal step was edited for the one-action flow and not run.

### 3f.2 New journals encrypted by default

**Status:** ✅ Done

**Design:** RFC 0002, Journals

The web's setup and its *change kind* offer an encrypted journal first, with the browser's identity, or ask for one to be made (as 2d.1 does). A plaintext journal is a choice the person makes.

**Accepts when:** a journal set up with the defaults is encrypted and passes the real `fjord verify` (`FJORD_CLI`); with no identity in the browser, the setup asks for one before it offers *encrypted*, and never makes a plaintext journal without being told to.

- **Done as:** `SetupOffer` offers a journal **encrypted first and selected**, plaintext as the second, explicit choice; with no key in the browser it says to make or import one and keeps *Set up* disabled until there is one or plaintext is chosen, so a plaintext journal is never made by default. The plan is unchanged and `fjord-core`'s (`planSetupKind`, tested against the real `fjord verify` since 3a.3). *Change kind* does not touch encryption, which is the vault's.
- **Not here:** an encrypted journal made with **no recipient** (the old behaviour with no key) is no longer reachable from the offer; the CLI still makes one (`W602` until `key add`).

### 3g.1 A site's vault below the root

**Status:** ✅ Done

**Design:** RFC 0002, Vaults at any depth, Sites

A site whose vault is the engine's own content folder (`src/content`, `_posts`), made by `init --adopt` or by the web's setup with P17's plan, opens on its posts as one made by Fjord does. The site's view lists every file of the vault as a tree.

**Accepts when:** an adopted Astro and Jekyll site open on their posts; a new post goes where the engine reads it; nothing outside the vault is offered for editing from the site's view.

- **Done as:**
  - **A vault is a directory at any depth in the browser** (`browse/location.ts`: the vault whose directory is the longest prefix of the path; `files/create.ts` `checkVault` accepts a vault's directory or a path inside it; the HTTP rules no longer refuse a slash in a vault's directory; a move's destination "stays" when it is inside the vault; `identify` asks of the whole path). A path outside every vault, a neighbour that only shares a name prefix with a vault, and a folder above one are all "missing".
  - **A post goes where the engine reads it** (`site/posts.ts`): `src/content/posts/<slug>.md` for an adopted Astro site, and straight into `_posts/` for a Jekyll vault that *is* `_posts`, not into a `_posts` inside it; a Jekyll draft there is refused (`draft_not_here`), since `_drafts` is beside the vault and outside it.
  - **The offer** (`browse/setup.ts`, `SetupOffer`): a repository that is not Fjord's and has an engine's files at its root is offered "this looks like an Astro/Jekyll site: use `src/content` / `_posts` as the vault, nothing of it changed or moved", first, with "start a new site" second. It is `planAdopt` through the format module (the CLI's `init --adopt`'s planner); the request is `{ kind: "ssg", engine, adopt }`, checked for shape and re-planned on the repository as it is when the button is pressed. One commit of `fjord.json`, the vault manifest and the merge guard.
  - **Tested:** browsing at depth (`location.test.ts`), the offer and the commit (`setup.test.ts`: found by its files, a repository that is not a site is offered none, the site byte for byte, read back as a site whose vault is below the root, a folder that cannot be a vault refused with nothing written), posts in both adopted layouts (`posts.test.ts`), the shape rules (`http.test.ts`, `access.test.ts`).
- **Not here:**
  - **A repository too large to list** is browsed a directory at a time from its root, so a vault below the root is not found in it; the listing must be whole.
  - **Encrypted vaults below the root are read but not written** from here: moving, restoring and transferring name a vault by a path's first segment, which for them is not the vault, and those operations refuse. Plaintext vaults are complete.
  - **The site's view is the posts list and the drive's folder view** ("Show files"), which is a tree of the vault's files; a separate tree in the site's own view is not built.
  - **A real Astro or Jekyll build of an adopted site** was not run (neither is installed here); `fjord.vault.json` in the content folder is what the CLI's spike would test.

### 3g.2 Source and rich modes, and the frontmatter form

**Status:** 📋 Planned

**Design:** RFC 0002, Sites

Each file of a site opens in source mode by default. Rich mode, with a frontmatter form (title, `date`, `tags`, draft, description, and any other key as key and value), is offered only when parse→serialise gives back the file byte for byte; otherwise it is disabled and the reason shown. The form writes through the module, keeping every key in order.

**Accepts when:** a post with an MDX component or a Liquid tag cannot be opened in rich mode and says why; a post edited in rich mode changes only what was changed; an unknown frontmatter key survives the form.

### 3h.1 Publish a Doc as a page

**Status:** 📋 Planned

**Design:** RFC 0002, Publishing a drive's Doc

A drive's Doc can be published at `/p/<token>`: rendered from its current version on the default branch, sanitised, read-only, with no account, `noindex` by default. It can be unpublished, which ends the address at once. Private publishing is today's shares and password links, which gain the same rendering. The token is hashed in the store and redacted from logs, as a share's is.

**Accepts when:** a published page opens in a private window with no cookies; raw HTML and script in the Doc do not reach the page; unpublishing turns the address into a 404; a draft is never what is published; who may publish is the policy's (`src/access/policy.ts`) and tested.

### 3h.2 Publish from an encrypted vault

**Status:** 📋 Planned

**Design:** RFC 0002, Publishing a drive's Doc

The sealed link (2c.1) gains 3h.1's rendering for private publishing. Public publishing of an encrypted Doc is offered only after a warning that the browser will give the server a plaintext copy of this version, readable by anyone with the address; the copy is kept until it is unpublished, and a later version is published again.

**Accepts when:** nothing is published from an encrypted vault without the warning being accepted; the server never receives a key; unpublishing deletes the copy.
