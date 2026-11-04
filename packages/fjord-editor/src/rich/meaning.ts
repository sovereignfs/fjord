// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";

/**
 * What a Markdown text means, as opposed to how it is written. The visual editor rewrites a document in its own style
 * when it saves (`-` for bullets, `*` for emphasis, a blank line between blocks), and that is not a loss. What would be a
 * loss is a structure it cannot hold: a tab-indented code block that becomes a list, a table row padded with a cell it did
 * not have, a footnote definition dropped. So a document is opened in the visual editor only if what the editor would
 * write back parses to the same tree as what it was given, positions aside; otherwise it is opened as Markdown, byte for
 * byte (ROADMAP 1b.3; DESIGN.md §10).
 *
 * The tree is `mdast` with GFM's tables, task lists and strikethrough: the Markdown the editor knows. Syntax the parser does
 * not know is text in it, and text that is not what a renderer that knows the syntax would read once it is written back
 * differently: `[[a wiki link]]` rewritten as `\[\[a wiki link]]` is the same text to this parser and a broken link to
 * Obsidian, and a footnote's `[^1]` is the same. So the text of a document is compared as it is written, backslashes
 * and all, not only as it reads. That asks more of the editor than it needs to for a plain document, and the answer to
 * not being sure is the Markdown editor, which changes nothing.
 */
const OPTIONS = {
  extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem()],
  mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown()],
};

/**
 * A piece of text as it was written, less the style that does not matter: a line continued in an indented or quoted block
 * is joined to the next without the indentation, and a backslash before a character that standard Markdown gives a meaning
 * to (`~ * _ \` |` and the backslash itself) is not kept, since whether it is written is the editor's style and every
 * renderer reads it the same. A backslash before any other character is kept: that is the editor protecting the text from
 * syntax the editor does not know and a renderer may.
 */
function plainly(raw: string, inHeading = false): string {
  let text = raw.replace(/\n[ \t>]*/g, "\n");
  // A bracket written as a character reference (`&#91;`) is the same literal bracket as an escaped one (`\[`), which is how the editor writes it; and the editor does not write
  // a backslash before a closing bracket that nothing opened, which nothing reads differently.
  text = text.replace(/&#(?:91|x5[bB]);/g, "\\[").replace(/&#(?:93|x5[dD]);/g, "]").replace(/\\\]/g, "]");
  // The number of a numbered heading (`## 1\. Introduction`, as a word processor's export writes it) is text, in a heading, whether or not it is escaped: a heading is never a list.
  if (inHeading) text = text.replace(/^(\d+)\\([.)])/, "$1$2");
  return text.replace(/\\([~*_`|\\])/g, "$1");
}

/**
 * The tree of a text without where in the text each node was, and with each piece of text as it was written. A line that
 * continues in an indented or quoted block is joined to the next without the indentation, which is style (a bullet changed
 * from `-` to `*` moves a continuation line, and nothing else).
 */
function describe(node: unknown, source: string, parent?: string): unknown {
  if (Array.isArray(node)) return node.map((child) => describe(child, source, parent));
  if (node === null || typeof node !== "object") return node;
  const record = node as { type?: string; position?: { start: { offset?: number }; end: { offset?: number } } } & Record<string, unknown>;
  const entries = Object.entries(record).filter(([key]) => key !== "position").map(([key, value]) => [key, describe(value, source, record.type)] as const);
  const start = record.position?.start.offset;
  const end = record.position?.end.offset;
  if (record.type === "text" && start !== undefined && end !== undefined) {
    return Object.fromEntries([...entries, ["raw", plainly(source.slice(start, end), parent === "heading")]]);
  }
  return Object.fromEntries(entries);
}

/** A description of what the text means: equal for two texts that mean the same, whatever their style. */
export function meaningOf(markdown: string): string {
  return JSON.stringify(describe(fromMarkdown(markdown, OPTIONS), markdown));
}

export function sameMeaning(a: string, b: string): boolean {
  return a === b || meaningOf(a) === meaningOf(b);
}

/** One place where what the visual editor would write is not what was written, for the person to look at and fix. */
export interface Difference {
  /** The line it starts on, counted in the text the editor was given (a document's body, below its header). */
  line: number;
  /** What is written there, trimmed to the part that matters. */
  written: string;
  /** What the visual editor would write instead; `null` when it would drop it. */
  becomes: string | null;
}

/** Why the visual editor cannot hold a text, for the person to read. */
export type Unsafe =
  | { reason: "line-endings" }
  | { reason: "meaning"; differences: Difference[] }
  /** Raw HTML, which the visual editor does not hold: where it is. */
  | { reason: "html"; spots: { line: number; written: string }[] }
  | { reason: "unreadable"; detail: string };

const WINDOW_BEFORE = 24;
const WINDOW_AFTER = 56;
const WHOLE_UP_TO = 140;

/** A piece of `source` for a person to read, one line, starting a little before `at` when given. */
function excerpt(source: string, start: number, end: number, at = 0): string {
  // A short piece is shown whole; a long one from a little before where it first differs.
  const whole = end - start <= WHOLE_UP_TO;
  const from = whole ? start : Math.max(start, start + at - WINDOW_BEFORE);
  const to = whole ? end : Math.min(end, start + at + WINDOW_AFTER);
  const flat = source.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > start ? "…" : ""}${flat}${to < end ? "…" : ""}`;
}

type Node = { type?: string; value?: string; children?: Node[]; position?: { start: { line: number; offset?: number }; end: { offset?: number } } } & Record<string, unknown>;

const bounds = (node: Node) => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 });
/** What is in a node besides its children and where it is: what it is, to compare apart from what is in it. */
const self = (node: Node, source: string) => JSON.stringify(describe(Object.fromEntries(Object.entries(node).filter(([key]) => key !== "children" && key !== "position")), source));

/**
 * Where `written`, the text the visual editor would write for `original`, is not `original` by meaning (`sameMeaning`): the deepest nodes that differ,
 * each with the line it starts on in `original`, what is written there and what would be written instead. At most `limit` are returned, since a
 * person fixes them one at a time and a document that is all one difference is not helped by a thousand lines of it.
 */
export function differences(original: string, written: string, limit = 12): Difference[] {
  const a = fromMarkdown(original, OPTIONS) as unknown as Node;
  const b = fromMarkdown(written, OPTIONS) as unknown as Node;
  const found: Difference[] = [];
  const report = (before: Node, after: Node | undefined) => {
    if (found.length >= limit) return;
    const left = bounds(before);
    // Text is shown from where it first differs, since a paragraph is long and the difference is a word of it.
    let at = 0;
    let atAfter = 0;
    if (before.type === "text" && after?.type === "text") {
      const right = bounds(after);
      const x = original.slice(left.start, left.end);
      const y = written.slice(right.start, right.end);
      while (at < x.length && at < y.length && x[at] === y[at]) at++;
      atAfter = at;
    }
    found.push({
      line: before.position?.start.line ?? 1,
      written: excerpt(original, left.start, left.end, at),
      becomes: after === undefined ? null : excerpt(written, bounds(after).start, bounds(after).end, atAfter),
    });
  };
  const walk = (before: Node, after: Node | undefined) => {
    if (found.length >= limit) return;
    if (after === undefined) return report(before, undefined);
    if (JSON.stringify(describe(before, original)) === JSON.stringify(describe(after, written))) return;
    const left = before.children;
    const right = after.children;
    if (before.type === after.type && Array.isArray(left) && Array.isArray(right) && self(before, original) === self(after, written)) {
      if (left.length === right.length) {
        for (const [index, child] of left.entries()) walk(child, right[index]);
        return;
      }
      // A different number of children: the first one that is not the other's is where they part.
      const index = left.findIndex((child, at) => right[at] === undefined || JSON.stringify(describe(child, original)) !== JSON.stringify(describe(right[at], written)));
      if (index >= 0 && left[index] !== undefined) return walk(left[index] as Node, right[index]);
      return report(before, after);
    }
    report(before, after);
  };
  walk(a, b);
  return found;
}

/** Every piece of raw HTML in the text, with its line: what the visual editor cannot hold, found by the parser that finds nothing else. */
export function htmlSpots(markdown: string, limit = 12): { line: number; written: string }[] {
  const found: { line: number; written: string }[] = [];
  const walk = (node: Node) => {
    if (found.length >= limit) return;
    if (node.type === "html") {
      const { start, end } = bounds(node);
      found.push({ line: node.position?.start.line ?? 1, written: excerpt(markdown, start, end) });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(markdown, OPTIONS) as unknown as Node);
  return found;
}

/**
 * What the visual editor said when it could not read a text (a library's own message), as something to tell the person: raw HTML, which is found, or
 * the structure it named, or what it said.
 */
export function unreadable(markdown: string, message: string): Unsafe {
  const named = /"type":"([A-Za-z]+)"/.exec(message)?.[1];
  if (named === "html") {
    const spots = htmlSpots(markdown);
    if (spots.length > 0) return { reason: "html", spots };
  }
  return { reason: "unreadable", detail: named ? `it contains a ${named} that it cannot hold` : "the visual editor could not read it" };
}

/**
 * The editor writes a document without its last line break (a document in a file has one) and without the blank lines it
 * began with (a body that follows a header does: the blank line between them). Give back what was given at both ends:
 * the blank lines it began with, whole, and a final line break if the original ended with one (a single one: a run of blank
 * lines at the end is not a thing to keep), none if it did not.
 */
export function withEdgesLike(original: string, exported: string): string {
  const body = exported.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\n+$/, "");
  // Nothing written: a document that was nothing but blank space is left as it was, anything else that was emptied is empty.
  if (body === "") return original.trim() === "" ? original : "";
  const lead = /^(?:[ \t]*\r?\n)*/.exec(original)?.[0] ?? "";
  return `${lead}${body}${original.endsWith("\n") || original === "" ? "\n" : ""}`;
}

/**
 * Whether the visual editor could write this text back with the line endings it has. It writes every line break as a line
 * feed, so a text with a carriage return in it (CRLF, from Windows, or the old Mac's CR) would have every line of it
 * rewritten by its first edit. That is a change of every line of a file, not of its style, and it is not found by comparing
 * what the text means, since a line break between blocks is in no node of the tree. Such a text is shown as Markdown.
 */
export function keepsLineEndings(text: string): boolean {
  return !text.includes("\r");
}
