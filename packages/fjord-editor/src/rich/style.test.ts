// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest";
import { withReadableDelimiters } from "./style.js";

/** The delimiter rows of the tables the editor writes (`style.ts`). */
describe("the delimiter row of a table", () => {
  it("gets three dashes a column where the library wrote one, and keeps the alignment", () => {
    expect(withReadableDelimiters("| a | b | c | d |\n| - | :- | -: | :-: |\n| 1 | 2 | 3 | 4 |\n")).toBe("| a | b | c | d |\n| --- | :--- | ---: | :---: |\n| 1 | 2 | 3 | 4 |\n");
  });

  it("is left as it is when it has three already, or the table is padded", () => {
    const padded = "| a   | b |\n| --- | --- |\n| 111 | 2 |\n";
    expect(withReadableDelimiters(padded)).toBe(padded);
  });

  it("is only a delimiter row under a table: a rule, a list of dashes or a row of a table with dashes in it is not", () => {
    for (const text of ["text\n\n---\n\nmore\n", "- a\n- b\n", "| a | - |\n| b | c |\n", "| - |\n"]) expect(withReadableDelimiters(text), text).toBe(text);
  });

  it("is not changed inside a fenced code block, however it looks", () => {
    const code = "```md\n| a | b |\n| - | - |\n```\n\n~~~\n| a |\n| - |\n~~~\n";
    expect(withReadableDelimiters(code)).toBe(code);
    expect(withReadableDelimiters(`${code}\n| x | y |\n| - | - |\n`)).toBe(`${code}\n| x | y |\n| --- | --- |\n`);
  });

  it("changes every table in a text, and nothing else", () => {
    expect(withReadableDelimiters("| a |\n| - |\n\ntext | with | pipes\n\n| b |\n| - |\n")).toBe("| a |\n| --- |\n\ntext | with | pipes\n\n| b |\n| --- |\n");
  });
});
