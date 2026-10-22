import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { routes, site } from "../site";
import { Landing } from "./Landing";
import { features, principles, questions, steps } from "./content";

const html = renderToStaticMarkup(<Landing />);
/** Parse the page so the tests can ask about its structure rather than its text. */
function page() {
  // A small reader is enough for structure, and needs no DOM.
  const all = (pattern: RegExp) => [...html.matchAll(pattern)];
  return {
    h1: all(/<h1[\s>]/g).length,
    headings: all(/<h([1-3])[^>]*>/g).map((m) => Number(m[1])),
    hrefs: all(/<a [^>]*href="([^"]+)"/g).map((m) => m[1]!),
    ids: all(/\sid="([^"]+)"/g).map((m) => m[1]!),
    details: all(/<details[\s>]/g).length,
    summaries: all(/<summary[\s>]/g).length,
    landmarks: Object.fromEntries(["header", "main", "footer"].map((t) => [t, all(new RegExp(`<${t}[\\s>]`, "g")).length])),
  };
}

describe("the landing page", () => {
  const p = page();

  it("has one h1, and headings that never skip a level", () => {
    expect(p.h1).toBe(1);
    expect(p.headings[0]).toBe(1);
    for (let i = 1; i < p.headings.length; i++) expect(p.headings[i]! - p.headings[i - 1]!).toBeLessThanOrEqual(1);
  });

  it("has a header, a main and a footer, once each", () => {
    expect(p.landmarks).toEqual({ header: 1, main: 1, footer: 1 });
  });

  it("offers sign in and sign up, more than once so a reader never has to scroll back", () => {
    expect(p.hrefs.filter((h) => h === routes.signIn).length).toBeGreaterThanOrEqual(2);
    expect(p.hrefs.filter((h) => h === routes.signUp).length).toBeGreaterThanOrEqual(2);
  });

  it("links to the source and the specification", () => {
    expect(p.hrefs).toContain(site.repository);
    expect(p.hrefs).toContain(site.specification);
  });

  it("points every in-page link at an element that exists", () => {
    const ids = new Set(p.ids);
    for (const href of p.hrefs.filter((h) => h.startsWith("#") && h.length > 1)) expect(ids.has(href.slice(1))).toBe(true);
    expect(ids.has("main")).toBe(true); // the skip link
  });

  it("has a unique id on every element that has one", () => {
    expect(new Set(p.ids).size).toBe(p.ids.length);
  });

  it("renders every principle, feature, step and question from the content", () => {
    for (const { title } of [...principles, ...features, ...steps]) expect(html).toContain(title);
    for (const { question } of questions) expect(html).toContain(question);
    expect(p.details).toBe(questions.length);
    expect(p.summaries).toBe(questions.length);
  });

  it("says it is not usable yet, and does not promise encryption today", () => {
    expect(html).toContain("being built in the open");
    expect(html).toContain("Comes after the first release");
  });

  it("has no script of its own: the FAQ is native, and the theme script lives in the layout", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
  });

  it("shows the example Fjord document as text a reader can select", () => {
    expect(html).toContain("<pre");
    expect(html).toContain("Plans/Q4 plan.fj.md");
  });
});
