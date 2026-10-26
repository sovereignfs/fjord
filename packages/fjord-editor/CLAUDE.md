# Build brief: fjord-editor

Instructions for whoever builds `packages/fjord-editor`, human or model. The repository-wide rules in the root
[`CLAUDE.md`](../../CLAUDE.md) apply here too (one task, one branch, one draft PR; commits explain why; docs are part of
the change). The design is [`clients/web/DESIGN.md`](../../clients/web/DESIGN.md) §10 and §13, the plan
[`clients/web/ROADMAP.md`](../../clients/web/ROADMAP.md) 1b.1 to 1b.3, and where this file and the design disagree the
design is right.

## Rules

- **MPL-2.0, and it depends on no client's design system.** React is the only dependency (a peer). Never import
  `@sovereignfs/ui` or anything of Fjord Web's: the desktop app, the editor plugins and the MPL-2.0 mobile client must be
  able to embed this package. `src/package.test.ts` fails if it does.
- **The look comes from `--fe-*` custom properties**, each with a default (`src/theme.ts` lists them), and from nothing
  else. No colour or font is written outside a `var()` default; a client maps its own tokens onto these.
- **One entry point.** A client can import `fjord-editor` and `fjord-editor/styles.css` and nothing deeper (`exports`).
  What a client needs is exported from `src/index.ts`; what is not exported is not the interface.
- **The interface is the contract, not the core.** `src/contract.test.tsx` says what an editor does whatever is behind
  it, and CodeMirror (1b.2) and MDXEditor (1b.3) must pass it unchanged. Change a core and these tests stay the same;
  change the interface and every client changes with it, so that is a design change (`clients/web/DESIGN.md` §10).
- **`onChange` is for the person's edits only.** Never for a change the app made by setting `value`, and never when the
  text may only be read. The whole new text, not a delta.
- **Frontmatter is not the editor's.** It is given the body and gives the body back; the app keeps the header
  (`DESIGN.md` §9).
- **A note's editor is byte-faithful** once it has its real core: an edit changes only what the person changed. The
  text area that stands in now is not (a browser turns every line ending into a line feed), and is not to be
  mistaken for it.
- **TypeScript is strict**, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; relative imports carry a
  `.js` extension so the build is valid Node ESM. No `any` without a comment saying why it cannot be avoided.
- **Dependencies are chosen, not accumulated**, and the lockfile is committed with any change to one. Every file
  carries the MPL header.
- **A change to behaviour adds a line under `## [Unreleased]`** in `CHANGELOG.md`.

## Commands

```bash
pnpm install --frozen-lockfile   # never `pnpm install` in CI or a PR check
pnpm typecheck
pnpm test
pnpm build && pnpm check:build
pnpm stories                     # Ladle
```
