import { describe, expect, it } from "vitest";
import { documentTitle, stemOf } from "./document";

describe("a file's name as a person calls it", () => {
  it("is without .md and .fj.md, and nothing else is taken off", () => {
    expect(stemOf("plan.md")).toBe("plan");
    expect(stemOf("Plan.FJ.MD")).toBe("Plan");
    expect(stemOf("notes.txt")).toBe("notes.txt");
    expect(stemOf("a.md.age")).toBe("a.md.age");
    expect(stemOf("v1.2 plan.md")).toBe("v1.2 plan");
  });
});

describe("what a document is called at the head of its page", () => {
  it("is the title its header gives it, whatever the body says", () => {
    expect(documentTitle("---\ntitle: Header title\n---\n# Heading\n", 29, "Header title", "x.md")).toBe("Header title");
    expect(documentTitle("# Heading\n", 0, "  ", "x.md")).toBe("Heading");
  });

  it("is otherwise the first level-one heading of the body", () => {
    expect(documentTitle("---\nid: 1\n---\nintro\n\n# The real title\n\n## Not this\n", 13, null, "x.md")).toBe("The real title");
    expect(documentTitle("# Closed heading #\n", 0, null, "x.md")).toBe("Closed heading");
    expect(documentTitle("## Only a second level\n", 0, null, "x.md")).toBe("x");
    expect(documentTitle("#tag is not a heading\n", 0, null, "x.md")).toBe("x");
  });

  it("does not take a heading from a code block, nor one in the header", () => {
    expect(documentTitle("```\n# not a title\n```\n\n# A title\n", 0, null, "x.md")).toBe("A title");
    expect(documentTitle("---\nnote: |\n  # in the header\n---\nbody\n", 38, null, "Plan.md")).toBe("Plan");
  });

  it("is otherwise the file's name without its extension", () => {
    expect(documentTitle("just text\n", 0, null, "test123.md")).toBe("test123");
    expect(documentTitle("", undefined, null, "Plan.fj.md")).toBe("Plan");
  });
});
