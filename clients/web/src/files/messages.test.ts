import { describe, expect, it } from "vitest";
import { clip, createEncryptedMessage, createMessage, deleteMessage, editMessage, encryptedEditMessage, isIdName, lineChanges, movedLines, render, titleOf } from "./messages";

const ID = "01jagc4k7pt8y3wqnmzv5xrb8j";

describe("what changed in a text", () => {
  it("counts the lines added and removed by the shortest edit", () => {
    expect(lineChanges(["a", "b", "c"], ["a", "b", "c"])).toEqual({ added: 0, removed: 0 });
    expect(lineChanges(["a", "b", "c"], ["a", "x", "c"])).toEqual({ added: 1, removed: 1 });
    expect(lineChanges(["a"], ["a", "b", "c"])).toEqual({ added: 2, removed: 0 });
    expect(lineChanges(["a", "b", "c"], [])).toEqual({ added: 0, removed: 3 });
    // A line moved is a line removed and a line added, which is what the shortest edit says.
    expect(lineChanges(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual({ added: 1, removed: 1 });
    expect(lineChanges(["x", "a", "y", "b", "z"], ["a", "b"])).toEqual({ added: 0, removed: 3 });
  });

  it("does not stop at a text too large for the table: the lines are counted as a bag", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const after = [...before.slice(0, 1500), "new", ...before.slice(1501)];
    const { added, removed } = lineChanges(before.map((line) => `${line}!`).concat(before), after.concat(before.map((line) => `${line}!`)));
    expect(added + removed).toBeGreaterThan(0);
    expect(lineChanges(before, after)).toEqual({ added: 1, removed: 1 });
  });
});

describe("a version of a note or a document", () => {
  const before = "---\nid: " + ID + "\ntitle: Q4 plan\n---\n\nIntro words.\n\n## Goals\n\nGrow.\n\n## Risks\n\nNone.\n";

  it("says where, how much and which parts, with the subject carrying the size", () => {
    const after = "---\nid: " + ID + "\ntitle: Q4 plan\n---\n\nIntro words.\n\n## Goals\n\nGrow a lot.\nAnd fast.\n\n## Next steps\n\nShip it.\n";
    const message = editMessage("Work/Plans/Q4 plan.md", before, after);
    expect(message.subject).toBe("Edit “Q4 plan” (+4 −3)");
    expect(message.body).toEqual([
      "Work/Plans/Q4 plan.md",
      "4 lines added, 3 removed · 6 → 12 words",
      "Changed: Goals · Added: Next steps · Removed: Risks",
    ]);
  });

  it("says a title changed, and that other properties did", () => {
    const retitled = before.replace("title: Q4 plan", 'title: "Q4 plan, final"');
    expect(editMessage("a/Q4 plan.fj.md", before, retitled).body).toContain("Retitled: “Q4 plan” → “Q4 plan, final”");
    const tagged = before.replace("title: Q4 plan", "title: Q4 plan\ntags: [a]");
    expect(editMessage("a/Q4 plan.fj.md", before, tagged).body).toContain("Properties changed.");
    expect(editMessage("a/n.md", "text\n", "---\ntitle: Hello\n---\ntext\n").body).toContain("Titled: “Hello”");
  });

  it("does not take a heading in a code fence for a section", () => {
    const fenced = (heading: string) => `intro\n\n\`\`\`\n# ${heading}\n\`\`\`\n`;
    expect(editMessage("a/n.md", fenced("one"), fenced("two")).body).not.toContain("Changed: one");
    expect(editMessage("a/n.md", fenced("one"), fenced("two")).body?.join("\n")).toContain("Changed: the introduction");
  });

  it("names the introduction when it is what changed, and lists no more than a few names", () => {
    expect(editMessage("a/n.md", "old\n\n# A\n\nx\n", "new\n\n# A\n\nx\n").body).toContain("Changed: the introduction");
    const many = (suffix: string) => Array.from({ length: 9 }, (_, i) => `# S${i}\n\n${suffix}\n`).join("\n");
    expect(editMessage("a/n.md", many("a"), many("b")).body?.join("\n")).toContain("Changed: S0, S1, S2, S3, S4 and 4 more");
  });

  it("is the name and the place when the old text could not be read, and when nothing changed", () => {
    expect(editMessage("a/b/n.md", undefined, "x")).toEqual({ subject: "Edit “n”", body: ["a/b/n.md"] });
    expect(editMessage("a/b/n.md", "same", "same")).toEqual({ subject: "Edit “n”", body: ["a/b/n.md"] });
  });

  it("is a subject of 72 characters at most, whatever the title", () => {
    expect(render(editMessage(`a/${"long ".repeat(40)}.md`, "a", "b")).split("\n")[0]!.length).toBeLessThanOrEqual(72);
    expect(clip("abc", 5)).toBe("abc");
    expect(clip("a  b\nc".repeat(30), 20).length).toBeLessThanOrEqual(20);
    expect(clip("a  b\nc".repeat(30), 20).endsWith("…")).toBe(true);
  });
});

describe("an encrypted file never gives away what is in it", () => {
  it("says only that it changed, by a name where it has one", () => {
    expect(encryptedEditMessage("Locked/Plan.md.age").subject).toBe("Edit encrypted “Plan”");
    expect(encryptedEditMessage(`Sealed/${ID}.age`).subject).toBe("Edit an encrypted file in Sealed");
    expect(render(encryptedEditMessage("Locked/Plan.md.age"))).not.toMatch(/line|word|Changed|Retitled/);
  });

  it("names a created file by its name, or by nothing when its name is an identifier", () => {
    expect(createEncryptedMessage({ path: "Locked/Notes/Meeting.md.age" })).toMatchObject({ subject: "Create encrypted “Meeting”" });
    const sealed = createEncryptedMessage({ path: `Sealed/${ID}.age` });
    expect(sealed.subject).toBe("Create an encrypted file in Sealed");
    expect(render(sealed)).not.toContain("document “");
  });

  it("calls an id-named deletion an encrypted file", () => {
    expect(deleteMessage({ path: `Sealed/${ID}.age`, folder: false, paths: [`Sealed/${ID}.age`] }).subject).toBe("Delete an encrypted file");
    expect(deleteMessage({ path: "Locked/Plan.md.age", folder: false, paths: ["Locked/Plan.md.age"] }).subject).toBe("Delete “Plan”");
  });
});

describe("a file made", () => {
  it("says what, where and how big, and gives the id when there is one", () => {
    const plain = createMessage({ path: "Notes/Projects/Meeting notes.md", text: "# Meeting notes\n" });
    expect(plain.subject).toBe("Create “Meeting notes”");
    expect(plain.body).toEqual(["Notes/Projects/Meeting notes.md", "A new document in Notes/Projects, 2 words to start with."]);
    const document = createMessage({ path: "Notes/Q4 plan.md", text: `---\nid: ${ID}\ntitle: Q4 plan\ncreated: "2026-10-22T14:30:00Z"\n---\n\n# Q4 plan\n` });
    expect(document.subject).toBe("Create “Q4 plan”");
    expect(document.body).toContain(`Document id: ${ID}`);
    expect(createMessage({ path: "N/2026-10-22 1430.md", text: "" }).body).toContain("A new document in N, empty to start with.");
  });
});

describe("a deletion", () => {
  it("names the file and where it can be got back from", () => {
    expect(deleteMessage({ path: "Notes/Weekly review.md", folder: false, paths: ["Notes/Weekly review.md"] })).toEqual({
      subject: "Delete “Weekly review”",
      body: ["Notes/Weekly review.md", "Kept in this history; Fjord Web can put it back from Recently deleted."],
    });
  });

  it("lists a folder's files, a few of them", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `Notes/Projects/f${i}.md`);
    const message = deleteMessage({ path: "Notes/Projects", folder: true, paths });
    expect(message.subject).toBe("Delete folder “Projects” (12 files)");
    expect(message.body?.[0]).toBe("Removes 12 files from Notes/Projects:");
    expect(message.body).toContain("- Notes/Projects/f9.md");
    expect(message.body).not.toContain("- Notes/Projects/f10.md");
    expect(message.body).toContain("- and 2 more");
  });
});

describe("a move", () => {
  it("lists the files that moved, a few of them", () => {
    expect(movedLines([{ from: "a/x.md", to: "b/x.md" }])).toEqual(["a/x.md → b/x.md"]);
    expect(movedLines(Array.from({ length: 11 }, (_, i) => ({ from: `a/${i}`, to: `b/${i}` })))).toHaveLength(11);
    expect(movedLines([])).toEqual([]);
  });

  it("knows a name from an identifier", () => {
    expect(isIdName(`${ID}.age`)).toBe(true);
    expect(isIdName("Plan.md.age")).toBe(false);
    expect(titleOf("a/Plan.md")).toBe("Plan");
    expect(titleOf(`a/Plan.md.age`)).toBe("Plan");
  });
});
