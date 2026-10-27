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
function plainly(raw: string): string {
  return raw.replace(/\n[ \t>]*/g, "\n").replace(/\\([~*_`|\\])/g, "$1");
}

/**
 * The tree of a text without where in the text each node was, and with each piece of text as it was written. A line that
 * continues in an indented or quoted block is joined to the next without the indentation, which is style (a bullet changed
 * from `-` to `*` moves a continuation line, and nothing else).
 */
function describe(node: unknown, source: string): unknown {
  if (Array.isArray(node)) return node.map((child) => describe(child, source));
  if (node === null || typeof node !== "object") return node;
  const record = node as { type?: string; position?: { start: { offset?: number }; end: { offset?: number } } } & Record<string, unknown>;
  const entries = Object.entries(record).filter(([key]) => key !== "position").map(([key, value]) => [key, describe(value, source)] as const);
  const start = record.position?.start.offset;
  const end = record.position?.end.offset;
  if (record.type === "text" && start !== undefined && end !== undefined) {
    return Object.fromEntries([...entries, ["raw", plainly(source.slice(start, end))]]);
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
