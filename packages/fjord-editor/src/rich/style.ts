// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The house style (ROADMAP 1b.4, `clients/web/DESIGN.md` §10): the one way the visual document editor writes Markdown. It rewrites the whole
 * document whenever it saves, so what it writes has to be a decision and not whatever a library defaults to. These are the choices; the README of
 * this package and the design say why. A document already written this way comes back byte for byte (`src/house-style.test.tsx` holds it to that),
 * so an edit changes the lines the person edited and no others; a document written another way is restyled, and the person is shown how before
 * they edit (`restyle.ts`, and the notice in `DocumentEditor`).
 *
 * | | |
 * | --- | --- |
 * | Bullets | `-` |
 * | Emphasis | `*italic*` |
 * | Strong | `**bold**` |
 * | Rules | `---` |
 * | Numbered lists | `1.` on every item, so that adding an item does not renumber the rest (and does not change every line in a diff) |
 * | Headings | `#`, never underlined |
 * | Code | fenced with backticks, never indented |
 * | Tables | `\| a \| b \|`, a space inside each pipe, columns **not** padded to line up, so that changing one cell changes one line |
 * | Line breaks | as written: a paragraph is never re-wrapped |
 * | Blocks | one blank line between them |
 */
export const HOUSE_STYLE = {
  /** What `mdast-util-to-markdown` is told. */
  toMarkdown: { bullet: "-", emphasis: "*", strong: "*", rule: "-", listItemIndent: "one", fences: true, incrementListMarker: false },
  /** What the table plugin is told. */
  table: { tableCellPadding: true, tablePipeAlign: false },
} as const;

/** A GFM table's delimiter row: `| --- | :-: |`. */
const DELIMITER_ROW = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Tables are written compact (`HOUSE_STYLE.table`: columns are not padded to line up), and the library then writes the delimiter row with one dash
 * per column, `| - | - |`. That is valid GFM, but not every reader of Markdown accepts less than three dashes, and `| --- | --- |` is what everyone
 * writes. So the delimiter rows of the tables in the text it wrote are given three, in the same place and the same alignment (`:---`, `---:`,
 * `:---:`), and nothing else is touched. A line that looks like one inside a fenced code block is code, and is left as it is.
 */
export function withReadableDelimiters(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const opens = FENCE.exec(line)?.[1];
    if (opens !== undefined) {
      if (fence === null) fence = opens;
      else if (opens[0] === fence[0] && opens.length >= fence.length && line.trim() === opens) fence = null;
      continue;
    }
    if (fence !== null || index === 0 || !DELIMITER_ROW.test(line) || !(lines[index - 1] as string).trimStart().startsWith("|")) continue;
    lines[index] = line.replace(/:?-+:?/g, (cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":") && cell.length > 1;
      return `${left ? ":" : ""}---${right ? ":" : ""}`;
    });
  }
  return lines.join("\n");
}
