# Fjord Web

The hosted web client for [Fjord](../../README.md): your documents as plain files in
a Git repository you control, edited in the browser, shared and commented on like
Google Docs.

**Status: under construction.** The app builds, but there is nothing to use yet:
the page is a placeholder. The design and the plan are:

- [`DESIGN.md`](DESIGN.md): what Fjord Web is, its architecture, and the decisions
  behind it.
- [`ROADMAP.md`](ROADMAP.md): the phases, the tasks, and how each is known to be done.
- [`CLAUDE.md`](CLAUDE.md): the conventions for whoever builds it, human or model.

The format every Fjord client follows is [`spec/SPEC.md`](../../spec/SPEC.md).

## Developing

Needs Node 24 and [pnpm](https://pnpm.io) 11 (the `packageManager` field in
`package.json` names the exact version). This directory is its own project with its
own lockfile; it is not part of the Rust workspace.

```bash
pnpm install        # dependencies, from pnpm-lock.yaml
pnpm dev            # http://localhost:3000
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same four checks for a change to this directory, and nothing else runs
for it (`.github/workflows/web-ci.yml`).

## Licence

[AGPL-3.0-or-later](LICENSE), because the app bundles `@sovereignfs/ui`
(`DESIGN.md` §18). The rest of the repository is MPL-2.0, and the specification is CC0.
