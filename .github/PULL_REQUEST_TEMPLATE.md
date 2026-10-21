## What and why

<!-- Describe what changed and why. Focus on the reasoning, not just the mechanics. -->

## Type of change

- [ ] `feat` — new feature or capability
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `chore` — tooling, scaffolding, dependencies, maintenance

## Related issue

<!-- Link any related issue: Closes #123 — delete if not applicable -->

## Spec reference

<!-- If this touches the format, cite the section (e.g. spec §6.6, diagnostic E201).
Delete if not applicable. -->

## Verification

- [ ] `cargo fmt --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo test --workspace` passes
- [ ] A regression test was seen to fail against the old code (for a `fix`)
- [ ] `## [Unreleased]` in the component's CHANGELOG is updated (for a change in behaviour)
- [ ] The spec, the fixtures and the code agree (for a change to the format)
- [ ] Relevant docs updated (README, ROADMAP, `CLAUDE.md`)

<!-- Merge with "Rebase and merge" only. Fix commit messages before merging. -->
