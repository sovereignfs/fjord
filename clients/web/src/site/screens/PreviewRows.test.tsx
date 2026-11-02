import { renderToStaticMarkup } from "react-dom/server";
import { describe as suite, expect, it } from "vitest";
import type { PreviewOutcome, PreviewView } from "../preview";
import { PreviewRows, describe } from "./PreviewRows";

/** Each state of a preview as the page says it (ROADMAP 3d.1), from what the host reported. */
const view = (outcome: PreviewOutcome): PreviewView => ({ branch: "fjord/preview/abc-20261102t220000z", commit: "c".repeat(40), startedAt: Date.UTC(2026, 10, 2, 22, 0), outcome, checks: [] });
const html = (outcome: PreviewOutcome) => renderToStaticMarkup(<PreviewRows previews={[view(outcome)]} onStop={() => undefined} />);

suite("a preview, as the page says it", () => {
  it("links the address the host gave for the preview, and only then", () => {
    const ready = html({ kind: "ready", url: "https://preview-abc.example" });
    expect(ready).toContain('href="https://preview-abc.example"');
    expect(ready).toContain("Open the preview");
    expect(ready).toContain('rel="noopener noreferrer"');
    for (const outcome of [{ kind: "waiting" }, { kind: "building" }, { kind: "built" }, { kind: "unsupported" }] as PreviewOutcome[]) expect(html(outcome), outcome.kind).not.toContain("href=");
  });

  it("says a build failed, with the host's link to why", () => {
    const failed = html({ kind: "failed", url: "https://ci.example/runs/9" });
    expect(failed).toContain("The build failed");
    expect(failed).toContain('href="https://ci.example/runs/9"');
    expect(failed).toContain("See why");
  });

  it("tells a host that builds no branches so, plainly, and names what to look at", () => {
    const said = describe({ kind: "unsupported" });
    expect(said.busy).toBe(false);
    expect(said.text).toContain("has not built this branch");
    expect(said.text).toContain("GitHub Pages does not");
  });

  it("is busy only while it waits for the host or is being built", () => {
    expect(["waiting", "building"].map((kind) => describe({ kind } as PreviewOutcome).busy)).toEqual([true, true]);
    expect(["ready", "built", "failed", "unsupported", "unreadable"].map((kind) => describe(kind === "ready" ? { kind: "ready", url: "https://x.example" } : ({ kind } as PreviewOutcome)).busy)).toEqual([false, false, false, false, false]);
  });

  it("offers to stop each one, and shows nothing with none", () => {
    expect(html({ kind: "waiting" })).toContain("Stop previewing");
    expect(renderToStaticMarkup(<PreviewRows previews={[]} />)).toBe("");
  });
});
