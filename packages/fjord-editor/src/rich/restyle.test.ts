// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { LIMIT, describeRestyle } from "./restyle.js";

/** The description of what a restyle changes: the changed lines in the order of the text, and how many. */
describe("what a restyle changes", () => {
  it("is nothing for a text written the same", () => {
    expect(describeRestyle("a\nb\n", "a\nb\n")).toMatchObject({ lines: [], removed: 0, added: 0, truncated: false });
  });

  it("lists the lines that go and the lines that come, with their numbers, and not the lines between", () => {
    const preview = describeRestyle("# T\n\n* one\n* two\n\ntext\n", "# T\n\n- one\n- two\n\ntext\n");
    expect(preview.lines).toEqual([
      { kind: "removed", line: 3, text: "* one" },
      { kind: "removed", line: 4, text: "* two" },
      { kind: "added", line: 3, text: "- one" },
      { kind: "added", line: 4, text: "- two" },
    ]);
    expect([preview.removed, preview.added, preview.truncated]).toEqual([2, 2, false]);
  });

  it("finds a line that moved as one going and one coming, and an added line as only that", () => {
    expect(describeRestyle("a\nb\nc\n", "a\nb\nx\nc\n").lines).toEqual([{ kind: "added", line: 3, text: "x" }]);
    expect(describeRestyle("a\nb\nc\n", "a\nc\n").lines).toEqual([{ kind: "removed", line: 2, text: "b" }]);
  });

  it("counts what it does not list, and says so", () => {
    const before = Array.from({ length: 100 }, (_, i) => `* item ${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `- item ${i}`).join("\n");
    const preview = describeRestyle(before, after);
    expect([preview.removed, preview.added, preview.lines.length, preview.truncated]).toEqual([100, 100, LIMIT, true]);
  });

  it("does not compare line by line past a size where it would be slow, and counts the stretch as changed", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a ${i}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, i) => `b ${i}`).join("\n");
    const started = Date.now();
    const preview = describeRestyle(before, after);
    expect(Date.now() - started).toBeLessThan(1000);
    expect([preview.removed, preview.added]).toEqual([3000, 3000]);
  });
});
