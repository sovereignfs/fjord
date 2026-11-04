import { describe, expect, it } from "vitest";
import { FILE_ICON, fileIconFor } from "./file-icons";
import { LUCIDE } from "../ui/lucide-nodes";

describe("the icon of a file", () => {
  it("is Markdown's for a Doc and for .md, an image's for images, a page's for HTML, a document's for a PDF, and a plain file's for the rest", () => {
    expect(fileIconFor("plan.md")).toBe("file-text");
    expect(fileIconFor("plan.fj.md", "doc")).toBe("file-text");
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.heic"]) expect(fileIconFor(name), name).toBe("file-image");
    expect(fileIconFor("report.pdf")).toBe("square-text");
    expect(fileIconFor("checklist.html")).toBe("file-code-corner");
    expect(fileIconFor("old.HTM")).toBe("file-code-corner");
    for (const name of ["data.csv", "archive.zip", "Makefile", ".gitignore", "noextension"]) expect(fileIconFor(name), name).toBe(FILE_ICON.file);
  });

  it("is the real name's for an encrypted file, whose suffix is not a kind of file", () => {
    expect(fileIconFor("photo.png.age", "payload")).toBe("file-image");
    expect(fileIconFor("plan.md.age", "payload")).toBe("file-text");
    expect(fileIconFor("something.age", "payload")).toBe(FILE_ICON.file);
  });

  it("only names icons that have a shape, so none is drawn as nothing", () => {
    const names = new Set<string>(Object.values(FILE_ICON));
    for (const name of ["a.md", "a.png", "a.pdf", "a.html", "a.bin"]) names.add(fileIconFor(name));
    for (const name of names) expect(LUCIDE[name], name).toBeDefined();
  });
});
