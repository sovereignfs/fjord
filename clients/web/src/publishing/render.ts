import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";

/**
 * Markdown to the HTML of a published page (DESIGN.md §12, ROADMAP 3h.1, RFC 0002). A page open to anyone is made of untrusted text, so this is not a
 * conversion followed by a cleaning: it is a **serializer of an allowlist**. The text is parsed to a syntax tree and only the nodes below are written, each
 * as one fixed tag with every piece of text escaped; **a raw HTML node is never written, as markup or at all** (its source is shown as text), a link is
 * written only with a `http`, `https`, `mailto` or in-page address, and an image is never loaded (its description is shown instead, so a page makes no
 * request to anyone else's server, as the Content-Security-Policy also says). What this does not know it writes as the text it holds. Nothing in the
 * output comes from the document but escaped text and an address that passed the check.
 */
interface Node {
  type: string;
  children?: Node[];
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  align?: (string | null)[] | null;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (character) => ESCAPES[character] as string);

/** An address a published page may link to: absolute `http(s)` or `mailto`, or a place in the same page. Anything else is not a link. */
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  // Control characters and spaces inside a scheme are how `java\tscript:` gets past a check that looks at the start of a string.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  if (/^#[^#]*$/.test(trimmed) && trimmed.length <= 200) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) && trimmed.toLowerCase().startsWith(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function text(node: Node): string {
  if (node.value !== undefined) return node.value;
  return (node.children ?? []).map(text).join("");
}

const inline = (nodes: Node[] | undefined): string => (nodes ?? []).map(write).join("");
const block = (nodes: Node[] | undefined): string => (nodes ?? []).map(write).filter((html) => html !== "").join("\n");

function write(node: Node): string {
  switch (node.type) {
    case "root":
      return block(node.children);
    case "paragraph":
      return `<p>${inline(node.children)}</p>`;
    case "heading": {
      const level = Math.min(Math.max(node.depth ?? 1, 1), 6);
      return `<h${level}>${inline(node.children)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>\n${block(node.children)}\n</blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start = node.ordered && typeof node.start === "number" && node.start !== 1 && Number.isSafeInteger(node.start) ? ` start="${node.start}"` : "";
      return `<${tag}${start}>\n${block(node.children)}\n</${tag}>`;
    }
    case "listItem": {
      const box = node.checked === true ? "[x] " : node.checked === false ? "[ ] " : "";
      return `<li>${box}${(node.children ?? []).map((child) => (child.type === "paragraph" ? inline(child.children) : write(child))).join("\n")}</li>`;
    }
    case "code":
      return `<pre><code>${escapeHtml(node.value ?? "")}</code></pre>`;
    case "thematicBreak":
      return "<hr>";
    case "table":
      return `<table>\n${(node.children ?? []).map((row, index) => `<tr>${(row.children ?? []).map((cell) => `<${index === 0 ? "th" : "td"}>${inline(cell.children)}</${index === 0 ? "th" : "td"}>`).join("")}</tr>`).join("\n")}\n</table>`;
    case "text":
      return escapeHtml(node.value ?? "");
    case "emphasis":
      return `<em>${inline(node.children)}</em>`;
    case "strong":
      return `<strong>${inline(node.children)}</strong>`;
    case "delete":
      return `<del>${inline(node.children)}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value ?? "")}</code>`;
    case "break":
      return "<br>";
    case "link": {
      const href = safeHref(node.url ?? "");
      return href === undefined ? inline(node.children) : `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${inline(node.children)}</a>`;
    }
    case "image":
      // Never loaded: a page makes no request to another server. The description is what is left.
      return escapeHtml(node.alt ?? "");
    case "html":
      // Raw HTML is the document's own markup, which a page open to anyone does not run. It is shown as the text it is.
      return escapeHtml(node.value ?? "");
    case "definition":
    case "footnoteDefinition":
    case "yaml":
      return "";
    default:
      // A node this does not know is written as the text it holds, in a paragraph if it holds block content.
      return node.children ? `<p>${escapeHtml(text(node))}</p>` : escapeHtml(node.value ?? "");
  }
}

/** The HTML of a Markdown body, safe to put in a page: see the comment at the top of this file. */
export function renderMarkdown(source: string): string {
  const tree = fromMarkdown(source, { extensions: [gfmTable(), gfmStrikethrough()], mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()] }) as unknown as Node;
  return write(tree);
}
