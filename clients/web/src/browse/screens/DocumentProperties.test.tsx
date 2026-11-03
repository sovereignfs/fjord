import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentProperties } from "./DocumentProperties";

/** The properties panel's tags field (ROADMAP 3b.3): the tags as written, and the tags already in use offered for what is being typed. */
const properties = (tags: string[] | null) => ({ id: "01jagc4k7pt8y3wqnmzv5xrb9c", title: null, created: null, date: null, tags, draft: null, description: null, others: [] });
const render = (tags: string[] | null, suggestions: string[] = []) =>
  renderToStaticMarkup(<DocumentProperties properties={properties(tags)} pending={false} disabled={false} onTitle={async () => null} onTags={async () => null} tagSuggestions={suggestions} />);

describe("the tags field", () => {
  it("shows the tags as they were written, each spelling kept", () => {
    expect(render(["Work", "project/fjord"])).toContain('value="Work, project/fjord"');
  });

  it("is only there where the page can change tags", () => {
    const html = renderToStaticMarkup(<DocumentProperties properties={properties(["a"])} pending={false} disabled={false} onTitle={async () => null} />);
    expect(html).not.toContain('name="tags"');
  });

  it("offers the other tags in use that begin as the last word does, never one already there, and nothing with nothing typed", () => {
    const html = render(["Work"], ["Work", "work-life", "health"]);
    expect(html).toContain("#work-life");
    expect(html).not.toContain("#health");
    expect(html).not.toContain("#Work<");
    expect(render([], ["Work"])).not.toContain("tag-suggestions");
  });
});

describe("the fields form (RFC 0002)", () => {
  const withOthers = (others: { key: string; value: string; editable?: "text" | "flag" }[], draft: boolean | null = null, description: string | null = null) => ({
    id: "01jagc4k7pt8y3wqnmzv5xrb9c",
    title: null,
    created: null,
    date: null,
    tags: null,
    draft,
    description,
    others,
  });
  const panel = (properties: ReturnType<typeof withOthers>, site: boolean) =>
    renderToStaticMarkup(<DocumentProperties properties={properties} pending={false} disabled={false} onTitle={async () => null} onField={async () => null} site={site} />);

  it("offers a site's post its draft and description, with what they are now, and no other kind of Doc", () => {
    const html = panel(withOthers([], true, "A first post."), true);
    expect(html).toContain('name="draft"');
    expect(html).toMatch(/name="draft"[^>]*checked/);
    expect(html).toContain('value="A first post."');
    expect(panel(withOthers([]), false)).not.toContain('name="draft"');
  });

  it("makes the keys it knows nothing about editable when they are text or a yes or no, and leaves the rest as they are", () => {
    const html = panel(withOthers([{ key: "layout", value: "post", editable: "text" }, { key: "featured", value: "true", editable: "flag" }, { key: "x-list", value: '["a","b"]' }]), false);
    expect(html).toContain('name="layout"');
    expect(html).toMatch(/name="featured"[^>]*checked/);
    // A list is shown as written and has no input.
    expect(html).not.toContain('name="x-list"');
    expect(html).toContain("x-list");
    expect(html).toContain("&quot;a&quot;");
  });

  it("is not there for a file that has no header yet, which would have to be given one first", () => {
    const html = renderToStaticMarkup(<DocumentProperties properties={withOthers([])} pending disabled={false} onTitle={async () => null} onField={async () => null} site />);
    expect(html).not.toContain('name="draft"');
    expect(html).not.toContain("Add a field");
  });
});
