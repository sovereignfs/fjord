# Workstreams

A **workstream** is an ordered sequence of epic tasks that together deliver one goal, with the decisions behind it already
settled, so that it can be picked up later and run leg by leg without the conversation that produced it. It is what an agent
is handed when it is told to run a feature end to end.

| Layer | Organises by | Answers |
| --- | --- | --- |
| [`ROADMAP.md`](../../ROADMAP.md) and each component's | shipping order | what is next, what is done |
| [`docs/epics/`](../epics/) | component and phase | every task in one area: what it is, when it is done, how it was done |
| [`docs/rfcs/`](../rfcs/) | decision | why a design was chosen |
| [`docs/research/`](../research/) | question | what was found before deciding |
| **`docs/workstreams/`** | **goal** | **the ordered path to one capability, across components** |

An epic groups tasks by component; a workstream groups them by goal. Epic task IDs stay the permanent identifiers: a
workstream refers to them and never renumbers or restates them.

## What a workstream is not

- **Not a task spec.** Task detail stays in `docs/epics/`.
- **Not a design document.** The format is `docs/specs/Fjord.spec.md`, a design is an RFC or a component's `DESIGN.md`. A
  workstream records which decisions are locked.
- **Not a status tracker.** Status stays in the roadmaps' rows and the epics' **Status** lines. A workstream's own status says
  only which leg it is on.
- **Not a licence to skip review**, or any rule of [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Legs

A workstream is divided into **legs**: a few tasks that belong together, run in order, ending at a review gate.

- **Each task in a leg is still one branch and one draft PR** ([`CLAUDE.md`](../../CLAUDE.md), Working conventions), named for
  its task. A leg is not a reason to put two tasks in one PR.
- **A leg ends with its tasks merged** and its "Done when" true. The next leg starts from an up-to-date `main`.
- **A leg may be a gate**: the next leg waits for an explicit decision from the owner, which is recorded in the workstream's
  changelog.
- **A leg may name a "Do not proceed if"** condition, checked before it starts. If it holds, stop and ask.
- **No version bumps.** In Fjord a release is its own PR (`RELEASING.md`), never part of a leg.
- **Finishing a task** is as for any task: marked done in its roadmap row, written up in its epic, and the leg's row of the
  workstream's changelog added when the leg is done.

To run a leg, read the workstream (its decisions and the leg's detail), then each task's block in its epic, then the spec
sections and the RFC it cites. Nothing else should be needed.

## Required sections

| Section | Why |
| --- | --- |
| **Goal** | What exists at the end that does not exist now |
| **Definition of done** | Checkable conditions |
| **Decisions locked** | Settled choices and the rejected alternatives, so they are not reopened mid-run |
| **Prerequisites** | What must be true before leg 1, including work owned elsewhere |
| **Legs** | Ordered table: leg, tasks, gate, done when |
| **Leg detail** | Why the leg is where it is, technical notes, and "Do not proceed if" |
| **Risks** | Known sharp edges |
| **Kill criteria** | What stops the workstream, and what survives if it does |

Copy [`TEMPLATE.md`](TEMPLATE.md) to `NNNN-short-slug.md` and add a row below.

## Index

| Workstream | Goal | Status | Governs |
| --- | --- | --- | --- |
| [0001](0001-repository-kinds.md) | A repository opens as what it is for: a drive, a journal with a timeline and tags, or an Astro or Jekyll site with a content editor and previews | ✅ Complete | RFC 0001, Research 0001, `web-3.md` |
| [0002](0002-kinds-second-pass.md) | One kind of Doc, addresses with no paths, journals encrypted by default, publishing a drive's Doc, and adopting existing files and sites | ✅ Complete | RFC 0002, `web-3.md` (P13–P17, 3e–3h) |

_Status key: ✅ Complete · ⏳ In progress · 📋 Planned · ⏸️ Paused · ❌ Stopped_
