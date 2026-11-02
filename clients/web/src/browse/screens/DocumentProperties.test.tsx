import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentProperties } from "./DocumentProperties";

/** The properties panel's tags field (ROADMAP 3b.3): the tags as written, and the tags already in use offered for what is being typed. */
const properties = (tags: string[] | null) => ({ id: "01jagc4k7pt8y3wqnmzv5xrb9c", title: null, created: null, date: null, tags, others: [] });
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
