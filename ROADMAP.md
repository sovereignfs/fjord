# Roadmap

What is built, what is being built and what is next, across the whole repository. **This file tracks progress; it does not define behaviour.**
[`docs/specs/Fjord.spec.md`](docs/specs/Fjord.spec.md) is authoritative on the format and [`CLAUDE.md`](CLAUDE.md) on how to build it; where either
disagrees with this file, this file is stale and should be corrected. The detail of every task is in [`docs/epics/`](docs/epics/), and how a task is run is in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

_Status key: ✅ Done · ⏳ In progress · 📋 Planned · 🚧 Open (waits on a decision) · ❌ Out of scope_

State as of 2026-10-31: the CLI's milestones are all done and `fjord-cli` 0.3.x is released (all 40 diagnostics are implemented); **Fjord Web's phase 1 is done** bar house style and a check against real GitHub
(sign in, connect a repository, browse, write and version, share, comment; idle versions included); mobile and the MCP server are designs; encrypted files in the browser are next for web (planned in `docs/epics/web-2.md`; they need a Rust toolchain first).

## Components

| Component | What | State | Plan |
| --- | --- | --- | --- |
| The format | The repository format, CC0 | ✅ Draft 1 | [`docs/specs/Fjord.spec.md`](docs/specs/Fjord.spec.md) |
| `fjord-core`, `fjord-cli` | The format as a library, and the CLI | ✅ M0 to M7 done, 0.3.x released | [Milestones](#fjord-core-and-fjord-cli) |
| `fjord-wasm` | `fjord-core`'s pure subset for WebAssembly | ✅ Built into the web client | [Web prerequisites](docs/epics/web-prerequisites.md) |
| Fjord Web | The hosted web client | ✅ Phase 1 done · 📋 phase 2 planned (tasks written), phase 3 an outline | [`clients/web/ROADMAP.md`](clients/web/ROADMAP.md) |
| `fjord-editor` | The document and note editors the clients share | ✅ Note editor, document editor, comment marks | [Web 1b](docs/epics/web-1b.md) |
| Fjord Mobile | iOS and Android | 📋 Design only | [`clients/mobile/ROADMAP.md`](clients/mobile/ROADMAP.md) |
| `fjord-mcp` | MCP server for Claude, later ChatGPT | 📋 Design only | [`clients/mcp/ROADMAP.md`](clients/mcp/ROADMAP.md) |
| Desktop, VS Code and Obsidian | | 📋 Not started | |

## fjord-core and fjord-cli

The acceptance criteria of each milestone are in [`CLAUDE.md`](CLAUDE.md), under Milestones. The journal of how each was built, and what it caught, is
[`docs/epics/cli.md`](docs/epics/cli.md).

| # | Milestone | Status | Detail |
| --- | --- | --- | --- |
| M0 | Groundwork: CI, the MSRV, age cross-validation, the fixture harness | ✅ Done (M0.5, the generated diagnostics table, is 📋 planned) | [Detail](docs/epics/cli.md#groundwork--m0) |
| M1 | `fjord verify`, read-only, no crypto | ✅ Done | [Detail](docs/epics/cli.md#m1-breakdown) |
| M2 | `fjord init` | ✅ Done | [Detail](docs/epics/cli.md#m2-notes) |
| M3 | Keys, encrypt, decrypt | ✅ Done | [Detail](docs/epics/cli.md#m3-notes) |
| M4 | `fjord open` | ✅ Done | [Detail](docs/epics/cli.md#m4-notes) |
| M5 | `new`, `ls`, `status`, `grep` | ✅ Done | [Detail](docs/epics/cli.md#m5-notes) |
| M6 | `fjord sync` | ✅ Done | [Detail](docs/epics/cli.md#m6-notes) |
| M7 | `fileNaming: "id"` and the tar container | ✅ Done | [Detail](docs/epics/cli.md#m7-notes) |

### After the milestones

| Item | Status | Detail |
| --- | --- | --- |
| Fixtures and the test suites | ✅ Done | [Fixtures](docs/epics/cli.md#fixtures) · [Tests](docs/epics/cli.md#test-suites) |
| `fjord rekey`, `fjord export` and `fjord import`, `cargo deny` in CI | ✅ Done | [Detail](docs/epics/cli.md#beyond-the-milestones) |
| Lowercase identifiers (a format change) | ✅ Done | [Detail](docs/epics/cli.md#format-change-lowercase-identifiers) |
| `vault add`: one step, `--json` | ✅ Done | [Detail](docs/epics/cli.md#vault-add-one-step---json-and-a-validation-bug-it-found) |
| The `generator` field | ✅ Done | [Detail](docs/epics/cli.md#generator) |
| Licence | ✅ Done | [Detail](docs/epics/cli.md#licence) |
| Release machinery, `scripts/release.sh`, the changelog as release notes | ✅ Done | [Detail](docs/epics/cli.md#release) |
| Conformance levels and `verify --fix` | ✅ Done | [Detail](docs/epics/cli.md#conformance-levels-and-the---fix-that-was-never-built) |
| A checkout, and the commit guard | ✅ Done | [Detail](docs/epics/cli.md#a-checkout-and-the-commit-guard-it-needed) |
| One repository, several components | ✅ Done | [Detail](docs/epics/cli.md#one-repository-several-components) |
| A development flow | ✅ Done | [Detail](docs/epics/cli.md#a-development-flow) |
| Homebrew tap | ✅ Done | [Detail](docs/epics/cli.md#homebrew) |
| M0.5: generate the README diagnostics table from `diagnostics::Code` | 📋 Planned | [Detail](docs/epics/cli.md#groundwork--m0) |
| Replace `unsafe-libyaml` as the frontmatter parser | 📋 Planned | [Detail](docs/epics/cli.md#beyond-the-milestones) |
| Publish to crates.io | 📋 Planned (not advertised until it exists) | [Detail](docs/epics/cli.md#beyond-the-milestones) |
| Frontmatter comment preservation | ❌ Out of scope for v1 (needs an AST-level YAML parser) | [Detail](docs/epics/cli.md#out-of-scope) |
