# Site

A Fjord repository of the **ssg** kind (`"kind": "ssg"` in `fjord.json`): a
static site built with {{engine}}, whose content is plain Markdown in one Fjord
vault, `content/`. The site builds with its own tools, with Fjord or without it.

## Layout

The site's content is in `content/`, a plaintext Fjord vault (a site is
published, so its content is never encrypted). Everything else is the site
engine's: its configuration, layouts and packages are ordinary files outside
the vault, and the engine is set up to read its posts from `content/`.

Each post is Markdown with a frontmatter block. Fjord's `id` gives it an
identity that survives a rename; the engine ignores it. `date` is the post's
date, and `tags` its tags.

Building and publishing the site is the job of your Git host or your own
machine. Fjord edits the content and never deploys.

{{build}}

The repository format is specified at
<https://github.com/sovereignfs/fjord/blob/main/docs/specs/Fjord.spec.md>.
