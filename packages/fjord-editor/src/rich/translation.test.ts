import { describe, expect, it } from "vitest";
import { translator } from "./translation";

describe("what the visual editor says", () => {
  it("fills the blanks MDXEditor leaves in its own text, so every heading level has its number", () => {
    const say = translator();
    expect(say("toolbar.blockTypes.heading", "Heading {{level}}", { level: 2 })).toBe("Heading 2");
    expect(say("x", "{{a}} of {{ b }}", { a: 1, b: "three" })).toBe("1 of three");
  });

  it("leaves a blank it was not given a value for, and text that has none, as they are", () => {
    const say = translator();
    expect(say("x", "Heading {{level}}", {})).toBe("Heading {{level}}");
    expect(say("x", "Heading {{level}}")).toBe("Heading {{level}}");
    expect(say("toolbar.paragraph", "Paragraph", { level: 1 })).toBe("Paragraph");
  });

  it("names the editing area for a screen reader when a page names it, and only that", () => {
    expect(translator("note.md")("contentArea.editableMarkdown", "editable markdown")).toBe("note.md");
    expect(translator()("contentArea.editableMarkdown", "editable markdown")).toBe("editable markdown");
    expect(translator("note.md")("toolbar.bold", "Bold")).toBe("Bold");
  });
});
