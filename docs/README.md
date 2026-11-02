# Documentation

| | |
| --- | --- |
| [`specs/Fjord.spec.md`](specs/Fjord.spec.md) | **The Fjord Repository Format.** Canonical; CC0 (the licence is in the file). Everything else follows it. |
| [`rfcs/`](rfcs/) | Proposals reviewed before they are built: the design, the alternatives and why. An accepted RFC that changes the format is carried into the spec by the task that implements it. |
| [`research/`](research/) | Open questions investigated before a design: what was read, found and recommended, dated. |
| [`workstreams/`](workstreams/) | Features that cross components, as an ordered run of epic tasks in legs, with their decisions locked, for picking up and running end to end. |
| [`epics/`](epics/) | The detail of every task of every roadmap: what it is, what makes it done, and how it was done. |
| [`security-review-phase-1.md`](security-review-phase-1.md) | The security review of Fjord Web's phase 1: what was checked, found, fixed and left. |
| [`security-review-phase-2.md`](security-review-phase-2.md) | The security review of Fjord Web's phase 2 (encrypted files, the identity in the browser, sealed shares): what the promise is and is not, what was found and fixed, the checks as tests, and the exceptions argued. |

The plans themselves are short tables, next to what they plan: [`ROADMAP.md`](../ROADMAP.md) for the whole repository, and one in each of
[`clients/web`](../clients/web/ROADMAP.md), [`clients/mobile`](../clients/mobile/ROADMAP.md) and [`clients/mcp`](../clients/mcp/ROADMAP.md). The designs are `DESIGN.md` in each client.

Where two documents disagree, the specification wins over everything else; a design (an accepted RFC, until its design moves into a `DESIGN.md`) wins over a plan; and a roadmap wins over a workstream's order.
