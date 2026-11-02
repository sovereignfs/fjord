# Research 0001 — The `ssg` kind: Astro and Jekyll sites in Fjord

| | |
| --- | --- |
| **Status** | Recommended, for review with [RFC 0001](../rfcs/0001-repository-kinds.md). The tasks are 3c and 3d in [`docs/epics/web-3.md`](../epics/web-3.md) |
| **Date** | November 2026 |
| **Author** | Claude Code |
| **Scope** | The `ssg` kind of RFC 0001: its scaffold, its content model, build status, preview and publishing |
| **Sources read** | 2026-11-02: Astro's content collections guide, Jekyll's collections, posts, front matter and configuration pages, Cloudflare's changelog on Workers Builds previews, and public descriptions of Decap, TinaCMS, Keystatic and Pages CMS. Nothing was built or run |

---

## Question

What does an `ssg` repository need from Fjord, for an Astro or a Jekyll site, so that a person can write the site's posts and
pages in Fjord Web? And how far should Fjord go: content editing only, a preview, a build of its own, or publishing?

## Method

- Read the engines' own documentation for where content lives, how it is configured, what frontmatter keys mean, and what
  becomes part of the built site.
- Read how the existing git-based content editors (Decap, TinaCMS, Keystatic, Pages CMS) are described, for what to learn and
  what not to copy.
- Read how the common hosts give a preview of a branch.
- Held every finding against the format's rules: vaults at the root and not nested (spec §2.3), plaintext for an `ssg` vault
  (RFC 0001), Fjord Docs with an `id` (§8), unknown keys kept (§8.2).

**Not done:** a site was not built with either engine, and no host's preview was set up. Each point marked **to confirm** below
is for the spike that opens task 3c.1.

## Findings

### Astro

1. **Content is declared, not found by convention.** Collections are defined in `src/content.config.ts` with
   `defineCollection()`. Markdown on disk is loaded by the `glob()` loader, which takes a `pattern` and a `base` path. The
   guide says `glob()` loads "from anywhere on the filesystem", though every example's `base` is under `src/`. So the content
   can sit in a root vault, `content/`, with `glob({ base: "./content/posts", pattern: "**/*.md" })`. **To confirm:** a `base`
   outside `src/`.
2. **The pattern keeps `fjord.vault.json` out.** `glob()` also loads JSON, YAML and TOML entries, so a loose pattern over the
   vault would take the vault's manifest for an entry. A pattern of `**/*.md` (or `**/*.{md,mdx}`) does not.
3. **Schemas are Zod.** Every field "must be defined using a Zod data type"; dates are `z.coerce.date()`. Zod's `z.object()`
   strips keys it does not declare by default, so Fjord's `id` (and any other unknown key) is dropped from the parsed data,
   not rejected. That is harmless: the file on disk is untouched. **To confirm:** that Astro does not make its schemas strict.
4. **An entry's `id` is Astro's own.** It is made from the file name. A frontmatter `slug` overrides it; a frontmatter `id` is
   not described as special. Fjord's `id` and Astro's `entry.id` are therefore separate, and Fjord must not write `slug` unless
   the person asks for it. **To confirm:** a frontmatter `id` does not override Astro's.
5. **Files outside `src/` and `public/` are not served.** `fjord.json`, `.gitattributes` and the vault's manifest never reach
   the built site.

### Jekyll

1. **Posts have a fixed place and name.** A post is in `_posts/`, named `YEAR-MONTH-DAY-title.MARKUP`. Since Jekyll 3.7,
   `collections_dir` moves every collection, and `_posts` and `_drafts` with them, into one directory, whose name cannot begin
   with an underscore. With `collections_dir: content`, the vault `content/` holds `content/_posts/` and `content/_drafts/`.
2. **`date` overrides the file name's date.** The front matter `date` is documented as `YYYY-MM-DD HH:MM:SS +/-TTTT`, with
   the time and offset optional. That is not RFC 3339: the separator is a space and the offset has no colon. **To confirm:**
   that Jekyll reads an RFC 3339 `date` (`2026-11-02T08:14:00+05:30`); Ruby's YAML loader reads it as a timestamp. Either way,
   a Jekyll site's existing dates are why RFC 0001 makes a non-RFC 3339 `date` a warning (`W606`), not an error.
3. **Tags are a list or a space-separated string.** `tags: classic hollywood` is two tags. Fjord writes a YAML list, which
   Jekyll reads as it is. A tag with a space cannot exist in Jekyll, so Fjord's tag field for a Jekyll site refuses one.
4. **Unknown front matter is kept and exposed** to templates as `page.<key>`. Fjord's `id` becomes `page.id`, unused.
   **To confirm:** that `page.id` does not clash with Jekyll's own `id` for a document (Jekyll gives documents an `id`
   attribute; a front matter key may shadow it).
5. **Jekyll copies files it does not process.** Dotfiles are excluded by default and `exclude` takes more (in Jekyll 4, added
   to the defaults). `fjord.json` at the root would be copied into the site, so the scaffold excludes it. **To confirm:** whether
   `content/fjord.vault.json`, inside `collections_dir` but in no collection, is copied; the scaffold excludes it too.

### What both engines need from Fjord

| | Astro | Jekyll |
| --- | --- | --- |
| The vault | `content/`, read through `glob()` | `content/`, as `collections_dir` |
| Posts | `content/posts/<slug>.md` | `content/_posts/YYYY-MM-DD-<slug>.md`: the name **is** a rule |
| Drafts | A `draft: true` field the site's code filters | `content/_drafts/<slug>.md`, or `published: false` |
| Pages | `content/pages/<slug>.md`, if the site's code routes them | Pages outside `_posts` live outside the vault, in the site's root: **not** in the content editor in this revision |
| Date | `date`, `z.coerce.date()` | `date`, overrides the name's date |
| Tags | `tags: z.array(z.string())` | `tags`, a list |
| Kept out of the site | Automatic: nothing outside `src/` and `public/` is served | `exclude: [fjord.json, content/fjord.vault.json]` |

So the content model of the `ssg` module is per engine, and for Jekyll the path is derived from `date` and the slug, as for a
plaintext journal, but here it is the engine's rule and not only a convention.

### Prior art

| Tool | How it works | Learn from it | Do not copy |
| --- | --- | --- | --- |
| **Decap CMS** (was Netlify CMS) | A single-page app served by the site itself (`/admin`), configured by a `config.yml` of collections and fields, committing through the git host's API; drafts as branches and pull requests ("editorial workflow") | Collections and fields declared per site; drafts as branches | An editor shipped inside the site; previews drawn from hand-written templates, not the real build |
| **TinaCMS** | A schema in code, a content API over the files, and a hosted or self-hosted backend that indexes them; editing on the real page | Typed fields | A backend index of the content; a hosted service in the loop |
| **Keystatic** | A schema in `keystatic.config.ts`, working on local files or through GitHub | The schema lives in the repository and in code the site already has | A dependency of the site's own build |
| **Pages CMS** | A hosted app with a GitHub App, configured by `.pages.yml` in the repository, no database | Closest to Fjord: the host's API, no database of content, a small config in the repository | — |

The common thread: the person edits fields, not files; the model of the content is declared per site; and the git host's API is
the backend. Fjord already has the last part (DESIGN §7, the `Provider`). For the first version, the content model can be
**fixed per engine** (the table above). A per-site model, saying which collections and fields a site has, is the obvious next
step, and the place for it is the `ssg` settings object of `fjord.json`, which would need a spec change of its own. Left as an
open question.

### Build status and preview

1. **Every common host reports back on the commit.** Cloudflare, Netlify and Vercel, connected to a GitHub repository, report
   their builds on the commit as statuses, checks or deployments, with the preview's address in them. GitHub Pages' own
   workflow reports a deployment too. So Fjord can show a build's state and a preview link **by reading the commit through the
   provider**, without an account at, or an integration with, any host. This is task 3c.3 (status) and 3d.1 (the preview's
   address).
2. **Previews are per branch.** Cloudflare has had branch previews for Pages for years, and since September 2026 for Workers
   too (Workers Builds give each branch a stable preview address and one per version). Netlify builds a preview per pull
   request and can deploy branches. Vercel deploys a preview for every push. So a preview means a branch: Fjord commits the
   working copy to a preview branch (not the default branch), waits for the host's status, and shows the link.
3. **GitHub Pages has no previews of its own.** Community actions deploy a pull request's build under a path of the live site
   (`/pr-preview/pr-<n>/`). A `preview` input to `actions/deploy-pages` appears in one of GitHub's own sample workflows but is
   not documented. **To confirm** before 3d.1 claims support for Pages.
4. **A build run by Fjord** means running the repository's code: `npm install` and `astro build`, or `bundle install` and
   `jekyll build`, with any plugin either pulls in. That is arbitrary code, from the network, on Fjord's servers. It needs a
   sandbox (a microVM or gVisor, no access to the instance's network or secrets, limits on CPU, memory and time), a cache of
   dependencies, and the result served from **another origin** than Fjord Web's, so that a site's scripts cannot run with
   Fjord's cookies or under its CSP (DESIGN §15). It is a project of its own, with its own security review.

### Publishing

Publishing stays the host's (spec §12, RFC 0001). The scaffold can include the host's usual workflow as an ordinary file:
Astro's GitHub Pages action, or GitHub's Jekyll Pages build. Fjord writes it once, when the repository is made. After that it is
the site's file, and Fjord never deploys. **To confirm** the actions' current names and versions at 3c.1.

## Options

| Option | What Fjord does | Cost | Risk |
| --- | --- | --- | --- |
| **A. Content editing** | Scaffold, posts and pages as Fjord Docs with fields, build status from the commit | Small: a kind module, a content model per engine, statuses through the provider | Low |
| **B. A + host previews** | A also commits to a preview branch and shows the host's preview link | Small on top of A: branch commits (the provider can already commit), statuses | Low. Needs a host that previews branches |
| **C. B + Fjord's own build** | Fjord builds the site in a sandbox and serves the result | Large: build runners, isolation, caching, a second origin, quotas | High: running untrusted code |
| **D. C + publishing** | Fjord deploys the site | Larger still, and reserved by §12 | High, and out of scope |

## Recommendation

**A first, then B. Design for C behind the same "actions" slot of the kind module, and do not build it until it has its own RFC
and security review. Never D.**

- **3c.1, the scaffold**, for Astro and Jekyll, with the vault at `content/`, the engine configured to read from it, the
  manifests kept out of the built site, and, optionally, the host's publishing workflow. It opens with a spike that settles every
  **to confirm** above against the engines' current releases.
- **3c.2, the content editor**: posts (and, for Astro, pages) with a fixed content model per engine: title, `date`, `tags`,
  draft, description. Paths follow the engine's rules (Jekyll's dated names). Drafts are the engine's own form, not a Fjord
  invention.
- **3c.3, build status** from the commit's statuses, checks and deployments, through the provider.
- **3d.1, previews through the host**: a preview branch per working copy (or one per person), the status of its build, and its
  link.
- **3d.2, a build in Fjord**: an outline only, until it has an RFC.

## Open questions

1. **A per-site content model** (collections and fields) in the `ssg` settings object: a spec change, and the way to support
   more than posts and pages.
2. **Importing an existing site** whose content is elsewhere (RFC 0001, open question 1).
3. **Hugo, Eleventy and others** would each be an `engine` value and a content model. They are not researched here.
4. **A preview branch's lifetime**: one per working copy or one per person, and who deletes it.

## Sources

- Astro, [Content collections](https://docs.astro.build/en/guides/content-collections/), read 2026-11-02.
- Jekyll, [Collections](https://jekyllrb.com/docs/collections/), [Posts](https://jekyllrb.com/docs/posts/),
  [Front Matter](https://jekyllrb.com/docs/front-matter/), [Configuration options](https://jekyllrb.com/docs/configuration/options/),
  read 2026-11-02.
- Cloudflare, [changelog: Workers Builds](https://developers.cloudflare.com/changelog/post/2026-09-22-cursor-origin-workers-builds/),
  and InfoQ's report of Worker Previews (September 2026).
- [`rossjrw/pr-preview-action`](https://github.com/rossjrw/pr-preview-action), and GitHub's
  [opensource.guide preview workflow](https://github.com/github/opensource.guide/blob/4fc063b090486708e2e6e9d91f83f31aab76a963/.github/workflows/jekyll-preview.yml),
  for previews on GitHub Pages.
- Decap CMS, TinaCMS, Keystatic and Pages CMS: their public descriptions. Their documentation was not read in full, and
  nothing here depends on a detail of theirs.

## Changelog

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-02 | Initial draft |
