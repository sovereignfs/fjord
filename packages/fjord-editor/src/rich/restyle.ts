// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What editing a document in the visual editor would change besides what the person edits (ROADMAP 1b.4). The editor writes the whole document in
 * the house style (`style.ts`), so a document written another way (in Obsidian, in an editor of the person's own, by `fjord`) would come out
 * with lines changed that nobody touched. That is allowed, because Fjord creates and owns documents, but it is not to be a surprise: the editor
 * reads the text, finds what it would write, and this describes the difference, line by line, for the person to see before they edit.
 */
export interface RestylePreview {
  /** The text as the app holds it. */
  before: string;
  /** The text the editor would write for it, unedited. */
  after: string;
  /** Lines that would go and lines that would come, in order, each with the number of the line in the text it is of, most `LIMIT` of them. */
  lines: readonly { kind: "removed" | "added"; line: number; text: string }[];
  removed: number;
  added: number;
  /** There were more changed lines than are listed. */
  truncated: boolean;
}

/** The most changed lines listed: a document written in another style may change all of them. */
export const LIMIT = 40;
/** The largest stretch of lines (rows times columns) that is compared line by line; a larger one is counted as all changed. */
const CELLS = 1_000_000;

const linesOf = (text: string): string[] => text.split("\n");

export function describeRestyle(before: string, after: string): RestylePreview {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const removed: boolean[] = new Array(a.length).fill(false);
  const added: boolean[] = new Array(b.length).fill(false);
  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > CELLS) {
    for (let i = start; i < endA; i++) removed[i] = true;
    for (let j = start; j < endB; j++) added[j] = true;
  } else {
    // The longest common run of lines in what is left, by the usual table; whatever is not in it is changed.
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j] ? (table[(i + 1) * width + j + 1] as number) + 1 : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) {
        i++;
        j++;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
        removed[start + i++] = true;
      } else {
        added[start + j++] = true;
      }
    }
    while (i < rows) removed[start + i++] = true;
    while (j < columns) added[start + j++] = true;
  }

  const lines: { kind: "removed" | "added"; line: number; text: string }[] = [];
  let removedCount = 0;
  let addedCount = 0;
  let i = 0;
  let j = 0;
  // In the order of the text: what goes, then what comes, at each place they differ.
  while (i < a.length || j < b.length) {
    if (i < a.length && removed[i]) {
      removedCount++;
      if (lines.length < LIMIT) lines.push({ kind: "removed", line: i + 1, text: a[i] as string });
      i++;
    } else if (j < b.length && added[j]) {
      addedCount++;
      if (lines.length < LIMIT) lines.push({ kind: "added", line: j + 1, text: b[j] as string });
      j++;
    } else {
      i++;
      j++;
    }
  }
  return { before, after, lines, removed: removedCount, added: addedCount, truncated: removedCount + addedCount > lines.length };
}
