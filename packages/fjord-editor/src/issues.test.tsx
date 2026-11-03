// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentEditor } from "./DocumentEditor.js";
import { LABEL } from "./testing/surfaces.js";

/**
 * When the visual editor cannot keep a document as written, the person is told where and what, so that they can fix it, and can ask again (ROADMAP: the
 * Markdown fallback explains itself).
 */
afterEach(cleanup);

const BAD = "# Title\n\nA paragraph that is fine.\n\n&#91;embedded content: roadmap\\]\n\nEnd.\n";
const GOOD = "# Title\n\nA paragraph that is fine.\n\n\\[embedded content: roadmap]\n\nEnd.\n";
const modeNow = () => document.querySelector("[data-mode]")?.getAttribute("data-mode");

/** The app holds the text; a button stands for the person fixing it in the Markdown editor. */
function App({ initial, fixed }: { initial: string; fixed: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button" onClick={() => setValue(fixed)}>
        fix it
      </button>
      <DocumentEditor aria-label={LABEL} role="edit" value={value} onChange={setValue} />
    </>
  );
}

describe("a document the visual editor cannot hold", () => {
  it("says which line, what is written there and what would be written, and nothing about the rest", async () => {
    render(<App initial={BAD} fixed={GOOD} />);
    await waitFor(() => expect(modeNow()).toBe("markdown"), { timeout: 8000 });
    const issues = await screen.findByRole("region", { name: "Why it is shown as Markdown" });
    const item = within(issues).getByRole("listitem");
    expect(item.textContent).toContain("Line 5");
    expect(item.textContent).toContain("&#91;embedded content: roadmap\\]");
    expect(item.textContent).toContain("\\[embedded content: roadmap]");
    expect(within(issues).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("note").textContent).toContain("cannot keep exactly as written");
  });

  it("opens in the visual editor when asked again after it was fixed, and not before", async () => {
    render(<App initial={BAD} fixed={GOOD} />);
    await waitFor(() => expect(modeNow()).toBe("markdown"), { timeout: 8000 });
    // Asked again with nothing fixed: it is still Markdown, and still says so.
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Why it is shown as Markdown" })).not.toBeNull(), { timeout: 8000 });
    expect(modeNow()).toBe("markdown");

    fireEvent.click(screen.getByRole("button", { name: "fix it" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(modeNow()).toBe("visual");
    expect(screen.queryByRole("region", { name: "Why it is shown as Markdown" })).toBeNull();
  });

  it("lists the raw HTML by line, when that is what it cannot hold", async () => {
    render(<App initial={"Intro.\n\n<details>\nInside.\n</details>\n"} fixed={"Intro.\n"} />);
    await waitFor(() => expect(modeNow()).toBe("markdown"), { timeout: 8000 });
    const issues = await screen.findByRole("region", { name: "Why it is shown as Markdown" });
    expect(issues.textContent).toContain("raw HTML");
    expect(within(issues).getAllByRole("listitem")[0]!.textContent).toContain("Line 3");
  });

  it("says it is the line endings, when it is", async () => {
    render(<App initial={"# T\r\n\r\ntext\r\n"} fixed={"# T\n\ntext\n"} />);
    await waitFor(() => expect(modeNow()).toBe("markdown"), { timeout: 8000 });
    const issues = await screen.findByRole("region", { name: "Why it is shown as Markdown" });
    expect(issues.textContent).toContain("carriage-return line endings");
  });

  it("says nothing when the visual editor can hold the document", async () => {
    render(<App initial={"# T\n\ntext\n"} fixed={"# T\n"} />);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(modeNow()).toBe("visual");
    expect(screen.queryByRole("region", { name: "Why it is shown as Markdown" })).toBeNull();
  });
});
